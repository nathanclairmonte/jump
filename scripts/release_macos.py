#!/usr/bin/env python3
"""Sign, notarize, and verify the final Jump macOS installer."""

import argparse
from contextlib import contextmanager, suppress
from dataclasses import asdict
import json
import os
from pathlib import Path, PurePosixPath
import plistlib
import re
import shutil
import subprocess
import sys
import tempfile
import uuid

from release import Candidate, ROOT, ReleaseError, accepted_receipt, record_candidate

TEAM = "M59NWWY4WZ"
BUNDLE_ID = "com.nathanclairmonte.jump"


def run(command, *, env=None, stream=False, check=True):
    try:
        result = subprocess.run(command, cwd=ROOT, env=env, capture_output=not stream, check=False)
    except OSError:
        raise ReleaseError(f"Could not start {Path(command[0]).name}") from None
    if check and result.returncode:
        raise ReleaseError(f"{Path(command[0]).name} failed with exit code {result.returncode}")
    return result


def output(command):
    result = run(command)
    return (result.stdout + result.stderr).decode("utf-8", errors="replace")


def credentials(env):
    identity = env.get("APPLE_SIGNING_IDENTITY") or env.get("APPLE_DEVELOPER_ID", "")
    if not identity.startswith("Developer ID Application:") or not identity.endswith(f"({TEAM})"):
        raise ReleaseError("A Developer ID Application identity for the expected team is required")
    if env.get("APPLE_TEAM_ID") != TEAM:
        raise ReleaseError("APPLE_TEAM_ID must equal the expected release team")
    if env.get("NOTARY_KEYCHAIN_PROFILE"):
        auth = ["--keychain-profile", env["NOTARY_KEYCHAIN_PROFILE"]]
    elif env.get("APPLE_ID") and env.get("APPLE_APP_SPECIFIC_PASSWORD"):
        auth = ["--apple-id", env["APPLE_ID"], "--password", env["APPLE_APP_SPECIFIC_PASSWORD"], "--team-id", TEAM]
    else:
        raise ReleaseError("An existing notarytool profile or Apple notarization credentials are required")
    return identity, auth


def notarize(path, receipt_path, auth):
    result = run(["xcrun", "notarytool", "submit", str(path), *auth, "--wait", "--output-format", "json"], check=False)
    try:
        receipt = accepted_receipt(result.stdout)
    except ReleaseError:
        try:
            response = json.loads(result.stdout)
            submission = str(uuid.UUID(response["id"]))
            status = response["status"]
            if status not in ("Invalid", "Rejected", "In Progress"):
                raise ValueError()
        except (ValueError, TypeError, KeyError, AttributeError):
            raise ReleaseError("Notarization failed without a usable submission receipt") from None
        raise ReleaseError(f"Notarization {submission} returned {status}") from None
    if result.returncode:
        raise ReleaseError(f"Notarization {receipt['id']} exited with code {result.returncode}")
    receipt_path.write_text(json.dumps(receipt, indent=2) + "\n")


def license_resources(root):
    config = json.loads((root / "src-tauri/tauri.conf.json").read_text())
    resources = config["bundle"]["resources"]
    if not isinstance(resources, dict) or not resources:
        raise ReleaseError("License resource map is missing")
    licenses = []
    for source, target in resources.items():
        destination = PurePosixPath(target)
        if not destination.parts or destination.is_absolute() or ".." in destination.parts:
            raise ReleaseError("Resource destination leaves the app resource directory")
        if destination.parts[0] == "licenses":
            file = root / "src-tauri" / source
            if not file.is_file() or not file.read_bytes():
                raise ReleaseError("A mandatory source license is missing or empty")
            licenses.append((file, Path(target)))
    if not licenses or len({target for _, target in licenses}) != len(licenses):
        raise ReleaseError("License resource destinations are missing or duplicated")
    return licenses


def verify_licenses(root, app):
    for source, target in license_resources(root):
        packaged = app / "Contents/Resources" / target
        if not packaged.is_file() or packaged.is_symlink() or packaged.read_bytes() != source.read_bytes():
            raise ReleaseError(f"Packaged license does not match {target}")


def verify_signature(path, *, app=False):
    command = ["codesign", "--verify", "--strict", "--verbose=2"]
    if app:
        command.append("--deep")
    run([*command, str(path)])
    metadata = output(["codesign", "--display", "--verbose=4", str(path)])
    authorities = re.findall(r"^Authority=(.+)$", metadata, re.MULTILINE)
    if not authorities or not authorities[0].startswith("Developer ID Application:") or not authorities[0].endswith(f"({TEAM})"):
        raise ReleaseError("Package lacks the expected Developer ID authority")
    if f"TeamIdentifier={TEAM}" not in metadata.splitlines():
        raise ReleaseError("Package signing team does not match")
    timestamp = re.search(r"^Timestamp=(.+)$", metadata, re.MULTILINE)
    if timestamp is None or timestamp[1].lower() in ("none", "not set"):
        raise ReleaseError("Package lacks a secure signing timestamp")
    if app and not re.search(r"^.*flags=.*\bruntime\b", metadata, re.MULTILINE):
        raise ReleaseError("App lacks the hardened runtime")


def verify_gatekeeper(path, *, app=False):
    run(["xcrun", "stapler", "validate", str(path)])
    command = ["spctl", "--assess", "--type", "execute" if app else "open", "--verbose=4"]
    if not app:
        command.extend(["--context", "context:primary-signature"])
    assessment = output([*command, str(path)])
    if "source=Notarized Developer ID" not in assessment.splitlines() or "accepted" not in assessment:
        raise ReleaseError("Gatekeeper did not accept a notarized Developer ID package")


@contextmanager
def mounted(dmg):
    mount = Path(tempfile.mkdtemp(prefix="jump-verify-"))
    try:
        run(["hdiutil", "attach", "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", str(mount), str(dmg)])
    except BaseException:
        with suppress(OSError):
            mount.rmdir()
        raise
    try:
        yield mount
    finally:
        original_error = sys.exc_info()[1]
        try:
            try:
                run(["hdiutil", "detach", str(mount)])
            except ReleaseError:
                run(["hdiutil", "detach", "-force", str(mount)])
        except ReleaseError:
            print(f"Installer volume remains mounted at {mount}", file=sys.stderr)
            if original_error is not None:
                raise original_error from None
            raise
        shutil.rmtree(mount)


def verify(dmg, candidate, root=ROOT):
    if sys.platform != "darwin":
        raise ReleaseError("Native package verification requires macOS")
    if dmg.name != candidate.installer:
        raise ReleaseError("DMG filename does not match the expected candidate")
    if output(["spctl", "--status"]).strip() != "assessments enabled":
        raise ReleaseError("Gatekeeper assessments must be enabled")
    verify_signature(dmg)
    verify_gatekeeper(dmg)
    with mounted(dmg) as volume:
        app = volume / "Jump.app"
        applications = volume / "Applications"
        if not app.is_dir() or app.is_symlink():
            raise ReleaseError("DMG does not contain Jump.app")
        if not applications.is_symlink() or os.readlink(applications) != "/Applications":
            raise ReleaseError("DMG lacks the Applications symlink")
        verify_signature(app, app=True)
        verify_gatekeeper(app, app=True)
        info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
        expected = {"CFBundleIdentifier": BUNDLE_ID, "CFBundleShortVersionString": candidate.version,
                    "CFBundleVersion": candidate.version,
                    "LSMinimumSystemVersion": json.loads((root / "src-tauri/tauri.conf.json").read_text())["bundle"]["macOS"]["minimumSystemVersion"]}
        if any(info.get(key) != value for key, value in expected.items()):
            raise ReleaseError("App metadata does not match the release candidate")
        executable = info.get("CFBundleExecutable", "")
        if not executable or Path(executable).name != executable:
            raise ReleaseError("App executable is invalid")
        if output(["lipo", "-archs", str(app / "Contents/MacOS" / executable)]).strip() != "arm64":
            raise ReleaseError("App architecture is not arm64")
        entitlement_result = run(["codesign", "--display", "--entitlements", "-", "--xml", str(app)])
        if not entitlement_result.stdout or b"warning:" in entitlement_result.stderr.lower():
            raise ReleaseError("App entitlement verification is incomplete")
        entitlements = plistlib.loads(entitlement_result.stdout)
        if not isinstance(entitlements, dict) or entitlements.get("com.apple.security.get-task-allow") not in (None, False):
            raise ReleaseError("App contains a debug entitlement")
        verify_licenses(root, app)
    return {"candidate": asdict(candidate), "verified": True}


def build(candidate, directory):
    identity, auth = credentials(os.environ)
    if sys.platform != "darwin":
        raise ReleaseError("Signed macOS builds require macOS")
    directory.mkdir(parents=True, exist_ok=False)
    build_env = {key: value for key, value in os.environ.items() if not key.startswith(("APPLE_", "NOTARY_"))}
    build_env["APPLE_SIGNING_IDENTITY"] = identity
    print("Building the signed app without automatic notarization", flush=True)
    run(["bun", "run", "tauri", "build", "--bundles", "app", "--target", "aarch64-apple-darwin",
         "--config", json.dumps({"bundle": {"macOS": {
             "hardenedRuntime": True, "entitlements": str(ROOT / "scripts/release-entitlements.plist")}}})], env=build_env, stream=True)
    license_resources(ROOT)
    app = ROOT / "src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Jump.app"
    verify_signature(app, app=True)
    with tempfile.TemporaryDirectory(prefix="jump-package-") as temporary:
        temporary = Path(temporary)
        archive = temporary / "Jump.app.zip"
        run(["ditto", "-c", "-k", "--keepParent", str(app), str(archive)])
        print("Notarizing the app", flush=True)
        notarize(archive, directory / "app-notary.json", auth)
        run(["xcrun", "stapler", "staple", str(app)])
        payload = temporary / "payload"
        payload.mkdir()
        run(["ditto", str(app), str(payload / "Jump.app")])
        (payload / "Applications").symlink_to("/Applications")
        dmg = directory / candidate.installer
        run(["hdiutil", "create", "-volname", "Jump", "-srcfolder", str(payload), "-format", "UDZO", str(dmg)])
    run(["codesign", "--sign", identity, "--timestamp", str(dmg)])
    print("Notarizing the DMG", flush=True)
    notarize(dmg, directory / "dmg-notary.json", auth)
    run(["xcrun", "stapler", "staple", str(dmg)])
    evidence = verify(dmg, candidate, ROOT)
    (directory / "verification.json").write_text(json.dumps(evidence, indent=2) + "\n")
    record_candidate(candidate, directory)
    print(f"Verified {candidate.installer}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("build", "verify"))
    parser.add_argument("--sha", required=True)
    parser.add_argument("--dmg", type=Path)
    parser.add_argument("--output", type=Path, default=Path(tempfile.gettempdir()) / "jump-release-macos")
    args = parser.parse_args()
    candidate = Candidate.for_platform(ROOT, args.sha, "macos")
    if args.command == "build":
        build(candidate, args.output.resolve())
    elif args.dmg:
        print(json.dumps(verify(args.dmg.resolve(), candidate), indent=2))
    else:
        raise ReleaseError("Verification requires --dmg")


if __name__ == "__main__":
    try:
        main()
    except ReleaseError as error:
        print(f"macOS release failed: {error}", file=sys.stderr)
        sys.exit(1)
    except (OSError, ValueError, KeyError, TypeError):
        print("macOS release failed because package data is incomplete", file=sys.stderr)
        sys.exit(1)
