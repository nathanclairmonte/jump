#!/usr/bin/env python3
"""Guard and stage immutable Jump release candidates."""

import argparse
from dataclasses import asdict, dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[1]


class ReleaseError(Exception):
    pass


@dataclass(frozen=True)
class Candidate:
    version: str
    source_sha: str
    architecture: str
    installer: str

    @classmethod
    def for_platform(cls, root, sha, platform):
        version = json.loads((root / "package.json").read_text())["version"]
        if not re.fullmatch(r"\d+\.\d+\.\d+", version):
            raise ReleaseError("Expected a stable package version")
        if not re.fullmatch(r"[0-9a-f]{40}", sha):
            raise ReleaseError("Expected a full source commit SHA")
        if platform == "macos":
            return cls(version, sha, "aarch64", f"Jump_{version}_aarch64.dmg")
        if platform == "windows":
            return cls(version, sha, "x86_64", f"Jump_{version}_x64-setup.exe")
        raise ReleaseError("Unsupported release platform")


def accepted_receipt(raw):
    try:
        receipt = json.loads(raw)
        uuid.UUID(receipt["id"])
        if receipt["status"] != "Accepted":
            raise ValueError()
    except (ValueError, TypeError, KeyError, AttributeError):
        raise ReleaseError("Notarization did not return an Accepted submission receipt") from None
    return receipt


def record_candidate(candidate, directory):
    installer = directory / candidate.installer
    if not installer.is_file() or installer.stat().st_size == 0:
        raise ReleaseError("Expected installer is missing or empty")
    data = asdict(candidate)
    data["sha256"] = hashlib.sha256(installer.read_bytes()).hexdigest()
    (directory / "candidate.json").write_text(json.dumps(data, indent=2) + "\n")
    (directory / "SHA256SUMS").write_text(f"{data['sha256']}  {candidate.installer}\n")


def verify_windows_header(installer):
    with installer.open("rb") as executable:
        header = executable.read(64)
        if len(header) != 64 or header[:2] != b"MZ":
            raise ReleaseError("Windows installer lacks its executable header")
        executable.seek(int.from_bytes(header[60:64], "little"))
        if executable.read(4) != b"PE\0\0":
            raise ReleaseError("Windows installer lacks its PE signature")


def validate_artifacts(root, sha, directory):
    installers = []
    expected_files = set()
    for platform in ("macos", "windows"):
        candidate = Candidate.for_platform(root, sha, platform)
        folder = directory / platform
        manifest = json.loads((folder / "candidate.json").read_text())
        if {key: manifest.get(key) for key in asdict(candidate)} != asdict(candidate):
            raise ReleaseError("Candidate does not match the immutable release source")
        installer = folder / candidate.installer
        if not installer.is_file() or installer.is_symlink() or installer.stat().st_size == 0:
            raise ReleaseError("Expected installer is missing or empty")
        digest = hashlib.sha256(installer.read_bytes()).hexdigest()
        if manifest.get("sha256") != digest:
            raise ReleaseError("Installer checksum does not match its candidate")
        if (folder / "SHA256SUMS").read_text() != f"{digest}  {candidate.installer}\n":
            raise ReleaseError("Installer checksum evidence is incomplete")
        files = {candidate.installer, "candidate.json", "SHA256SUMS"}
        if platform == "macos":
            for name in ("app-notary.json", "dmg-notary.json"):
                accepted_receipt((folder / name).read_text())
            verification = json.loads((folder / "verification.json").read_text())
            if verification != {"candidate": asdict(candidate), "verified": True}:
                raise ReleaseError("Native package verification evidence is incomplete")
            files |= {"app-notary.json", "dmg-notary.json", "verification.json"}
        else:
            verify_windows_header(installer)
        expected_files |= {folder / name for name in files}
        installers.append(installer)
    actual_files = {path for path in directory.rglob("*") if path.is_file() or path.is_symlink()}
    if actual_files != expected_files:
        raise ReleaseError("Release artifacts do not match the exact expected set")
    return installers


class GitHub:
    def __init__(self, repository, token):
        if not re.fullmatch(r"[\w.-]+/[\w.-]+", repository) or not token:
            raise ReleaseError("GitHub repository and token are required")
        self.repository = repository
        self.token = token

    def request(self, path, method="GET", data=None, missing_ok=False, upload=False, expected_list=False):
        host = "uploads.github.com" if upload else "api.github.com"
        headers = {"Authorization": f"Bearer {self.token}", "Accept": "application/vnd.github+json",
                   "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/octet-stream" if upload else "application/json"}
        body = data if upload else json.dumps(data).encode() if data is not None else None
        request = urllib.request.Request(f"https://{host}/repos/{self.repository}/{path}", data=body, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                result = json.load(response)
            if not isinstance(result, list if expected_list else dict):
                raise ReleaseError("GitHub returned an invalid response shape")
            return result
        except urllib.error.HTTPError as error:
            error.close()
            if missing_ok and error.code == 404:
                return None
            raise ReleaseError(f"GitHub request failed with HTTP {error.code}") from None
        except (urllib.error.URLError, TimeoutError, ValueError):
            raise ReleaseError("GitHub request failed without a confirmed response") from None

    def guard(self, candidate):
        tag = f"v{candidate.version}"
        release = self.request(f"releases/tags/{tag}", missing_ok=True)
        if release is not None:
            raise ReleaseError("Published release exists or its absence could not be confirmed")
        if self.request(f"git/ref/tags/{tag}", missing_ok=True) is not None:
            raise ReleaseError("Release tag already exists; read-only preflight cannot verify its draft state")

    def find_draft(self, candidate):
        matches = []
        page = 1
        while True:
            releases = self.request(f"releases?per_page=100&page={page}", expected_list=True)
            for release in releases:
                if not isinstance(release, dict) or not isinstance(release.get("tag_name"), str) or not release["tag_name"]:
                    raise ReleaseError("GitHub returned an incomplete release listing")
                if release["tag_name"] == f"v{candidate.version}":
                    matches.append(release)
            if len(releases) < 100:
                break
            page += 1
        if len(matches) > 1:
            raise ReleaseError("Multiple releases match the candidate tag")
        if not matches:
            if self.request(f"git/ref/tags/v{candidate.version}", missing_ok=True) is not None:
                raise ReleaseError("Orphan release tag exists")
            return None
        self.check_draft(candidate, matches[0])
        return matches[0]

    def check_draft(self, candidate, release):
        if release.get("draft") is not True or release.get("assets") != []:
            raise ReleaseError("Release must be an empty draft")
        if release.get("tag_name") != f"v{candidate.version}" or release.get("target_commitish") != candidate.source_sha:
            raise ReleaseError("Draft release does not target the exact source SHA")
        if type(release.get("id")) is not int or release["id"] <= 0:
            raise ReleaseError("Draft release has no valid ID")
        reference = self.request(f"git/ref/tags/v{candidate.version}", missing_ok=True)
        if reference is not None:
            obj = reference["object"]
            for _ in range(10):
                if obj["type"] != "tag":
                    break
                obj = self.request(f"git/tags/{obj['sha']}")["object"]
            if obj["type"] != "commit" or obj["sha"] != candidate.source_sha:
                raise ReleaseError("Release tag does not target the exact source SHA")

    def stage(self, root, sha, directory):
        installers = validate_artifacts(root, sha, directory)
        candidate = Candidate.for_platform(root, sha, "macos")
        release = self.find_draft(candidate)
        if release is None:
            release = self.request("releases", "POST", {"tag_name": f"v{candidate.version}",
                                   "target_commitish": sha, "name": f"v{candidate.version}", "draft": True})
            self.check_draft(candidate, release)
        checked = self.request(f"releases/{release['id']}")
        self.check_draft(candidate, checked)
        if checked["id"] != release["id"]:
            raise ReleaseError("Draft release changed before staging")
        release_id = release["id"]
        for installer in installers:
            self.request(f"releases/{release_id}/assets?name={urllib.parse.quote(installer.name)}",
                         "POST", installer.read_bytes(), upload=True)
        result = self.request(f"releases/{release_id}")
        expected = {path.name for path in installers}
        if result.get("draft") is not True or {asset["name"] for asset in result["assets"]} != expected:
            raise ReleaseError("Staged draft does not contain the exact installer set")
        print(f"Staged draft v{candidate.version}. Publishing requires a separate manual action.")


def main():
    parser = argparse.ArgumentParser(description=__doc__, epilog="preflight and guard check published releases and existing tags only; stage requires contents:write to inspect drafts")
    parser.add_argument("command", choices=("preflight", "guard", "record-windows", "verify-artifacts", "stage"))
    parser.add_argument("--sha", required=True)
    parser.add_argument("--confirm-version")
    parser.add_argument("--artifacts", type=Path, default=Path("release-artifacts"))
    args = parser.parse_args()
    candidate = Candidate.for_platform(ROOT, args.sha, "macos")
    if args.command == "verify-artifacts":
        validate_artifacts(ROOT, args.sha, args.artifacts)
        print(f"Verified both installer candidates for v{candidate.version} at {args.sha}")
        return
    if args.command == "record-windows":
        candidate = Candidate.for_platform(ROOT, args.sha, "windows")
        source = ROOT / "src-tauri/target/release/bundle/nsis"
        if {path.name for path in source.glob("*.exe")} != {candidate.installer}:
            raise ReleaseError("NSIS output does not match the expected installer")
        verify_windows_header(source / candidate.installer)
        args.artifacts.mkdir(parents=True, exist_ok=False)
        shutil.copy2(source / candidate.installer, args.artifacts / candidate.installer)
        record_candidate(candidate, args.artifacts)
        return
    if args.command == "preflight":
        if os.environ.get("GITHUB_REF") != "refs/heads/main" or os.environ.get("GITHUB_EVENT_NAME") != "workflow_dispatch":
            raise ReleaseError("Release requires manual dispatch on main")
        if args.confirm_version != candidate.version:
            raise ReleaseError("Version confirmation must equal package.json")
    github = GitHub(os.environ.get("GITHUB_REPOSITORY", ""), os.environ.get("GH_TOKEN", ""))
    if args.command == "stage":
        github.stage(ROOT, args.sha, args.artifacts)
    else:
        github.guard(candidate)
        print(f"Release candidate v{candidate.version} at {candidate.source_sha} passed published-release and tag checks. Drafts require the write-token staging check.")


if __name__ == "__main__":
    try:
        main()
    except ReleaseError as error:
        print(f"Release failed: {error}", file=sys.stderr)
        sys.exit(1)
    except (OSError, ValueError, KeyError, TypeError):
        print("Release failed. Check the candidate, credentials, and immutable draft state.", file=sys.stderr)
        sys.exit(1)
