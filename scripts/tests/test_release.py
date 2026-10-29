from contextlib import contextmanager
from dataclasses import asdict
import io
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import urllib.error
import urllib.parse

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import release
import release_macos as mac

SHA = "a" * 40
OTHER_SHA = "b" * 40
RECEIPT = '{"id":"155bb6ab-0010-4d65-86d5-d9da6ca6f49a","status":"Accepted"}'
IDENTITY = "Developer ID Application: Example (M59NWWY4WZ)"
WINDOWS_INSTALLER = b"MZ" + b"\0" * 58 + (64).to_bytes(4, "little") + b"PE\0\0installer"


class Response(io.BytesIO):
    def __init__(self, value):
        super().__init__(json.dumps(value).encode())


class GitHubServer:
    def __init__(self, draft=None, tag=None, releases=None):
        self.draft = draft
        self.releases = releases if releases is not None else [draft] if draft is not None else []
        self.tag = tag
        self.writes = []
        self.gets = 0
        self.change_on_get = None
        self.reads = []

    def __call__(self, request, **kwargs):
        url = urllib.parse.urlparse(request.full_url)
        path = url.path.split("/repos/owner/jump/")[1]
        if request.method == "GET":
            self.gets += 1
            self.reads.append(path + (f"?{url.query}" if url.query else ""))
            if self.change_on_get:
                self.change_on_get(self)
            if path == "releases":
                query = urllib.parse.parse_qs(url.query)
                count = int(query.get("per_page", [30])[0])
                start = (int(query.get("page", [1])[0]) - 1) * count
                return Response(self.releases[start:start + count])
            if path.startswith("releases/tags/"):
                value = next((item for item in self.releases if item["tag_name"] == path.removeprefix("releases/tags/")
                              and item["draft"] is False), None)
            elif path.startswith("releases/"):
                value = next((item for item in self.releases if str(item["id"]) == path.removeprefix("releases/")), None)
            elif path.startswith("git/"):
                value = self.tag
            else:
                raise AssertionError(f"Unexpected GitHub read {path}")
            if value is None:
                raise urllib.error.HTTPError(request.full_url, 404, "Not Found", {}, None)
            return Response(value)
        self.writes.append((request.method, path, request.data))
        if request.method != "POST":
            raise AssertionError(f"Unexpected GitHub write {request.method} {path}")
        if path == "releases":
            self.draft = {**json.loads(request.data), "id": 42, "assets": []}
            self.releases.append(self.draft)
            return Response(self.draft)
        if path != f"releases/{self.draft['id']}/assets":
            raise AssertionError(f"Unexpected GitHub upload {path}")
        name = urllib.parse.parse_qs(url.query)["name"][0]
        if any(asset["name"] == name for asset in self.draft["assets"]):
            raise urllib.error.HTTPError(request.full_url, 422, "Already exists", {}, None)
        self.draft["assets"].append({"name": name})
        return Response({"name": name})


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / "package.json").write_text('{"version":"0.1.4"}')
        self.candidate = release.Candidate.for_platform(self.root, SHA, "macos")
        self.github = release.GitHub("owner/jump", "private-token")

    def draft(self, **changes):
        return {"id": 42, "tag_name": "v0.1.4", "target_commitish": SHA, "draft": True, "assets": [], **changes}

    def artifacts(self):
        directory = self.root / "artifacts"
        for platform in ("macos", "windows"):
            candidate = release.Candidate.for_platform(self.root, SHA, platform)
            folder = directory / platform
            folder.mkdir(parents=True)
            (folder / candidate.installer).write_bytes(WINDOWS_INSTALLER if platform == "windows" else b"DMG image")
            release.record_candidate(candidate, folder)
            if platform == "macos":
                (folder / "app-notary.json").write_text(RECEIPT)
                (folder / "dmg-notary.json").write_text(RECEIPT)
                (folder / "verification.json").write_text(json.dumps({"candidate": asdict(candidate), "verified": True}))
        return directory

    def test_only_confirmed_404_means_missing(self):
        for failure in (urllib.error.HTTPError("url", 401, "Unauthorized", {}, None),
                        urllib.error.HTTPError("url", 403, "Forbidden", {}, None),
                        urllib.error.HTTPError("url", 500, "Server error", {}, None),
                        urllib.error.URLError("token-sensitive detail"), TimeoutError(), ValueError("malformed JSON")):
            with self.subTest(failure=type(failure).__name__), patch("urllib.request.urlopen", side_effect=failure):
                with self.assertRaises(release.ReleaseError) as caught:
                    self.github.guard(self.candidate)
                self.assertNotIn("private-token", str(caught.exception))
                self.assertNotIn("token-sensitive", str(caught.exception))
        with patch("urllib.request.urlopen", side_effect=GitHubServer()):
            self.assertIsNone(self.github.guard(self.candidate))

    def test_existing_tag_is_rejected_by_read_only_guard(self):
        server = GitHubServer(tag={"object": {"type": "commit", "sha": SHA}})
        with patch("urllib.request.urlopen", side_effect=server), self.assertRaises(release.ReleaseError):
            self.github.guard(self.candidate)
        self.assertEqual(server.writes, [])

    def test_successful_but_incomplete_github_payload_is_not_missing(self):
        for value in (None, [], "", {}, {"draft": True}):
            with self.subTest(value=value), patch("urllib.request.urlopen", side_effect=lambda *args, **kwargs: Response(value)):
                with self.assertRaises(release.ReleaseError):
                    self.github.guard(self.candidate)

    def test_staging_discovery_rejects_published_nonempty_wrong_source_and_wrong_tag(self):
        directory = self.artifacts()
        for draft, tag in ((self.draft(draft=False), None),
                           (self.draft(assets=[{"name": "anything"}]), None),
                           (self.draft(target_commitish=OTHER_SHA), None),
                           (self.draft(target_commitish="main"), None),
                           (self.draft(), {"object": {"type": "commit", "sha": OTHER_SHA}}),
                           (self.draft(id=True), None), (self.draft(id=0), None)):
            server = GitHubServer(draft, tag)
            with self.subTest(draft=draft, tag=tag), patch("urllib.request.urlopen", side_effect=server):
                with self.assertRaises(release.ReleaseError):
                    self.github.stage(self.root, SHA, directory)
            self.assertEqual(server.writes, [])

    def test_read_only_guard_checks_only_published_release_and_tag(self):
        server = GitHubServer(self.draft(assets=[{"name": "existing"}]))
        with patch("urllib.request.urlopen", side_effect=server):
            self.assertIsNone(self.github.guard(self.candidate))
        self.assertEqual(server.reads, ["releases/tags/v0.1.4", "git/ref/tags/v0.1.4"])
        self.assertEqual(server.writes, [])
        server = GitHubServer(self.draft(draft=False))
        with patch("urllib.request.urlopen", side_effect=server), self.assertRaises(release.ReleaseError):
            self.github.guard(self.candidate)
        self.assertEqual(server.writes, [])

    def test_matching_empty_draft_and_existing_matching_tag_are_accepted_at_staging(self):
        for tag in (None, {"object": {"type": "commit", "sha": SHA}}):
            with patch("urllib.request.urlopen", side_effect=GitHubServer(self.draft(), tag)):
                self.assertEqual(self.github.find_draft(self.candidate)["id"], 42)

    def test_staging_discovers_drafts_after_first_page(self):
        other_releases = [self.draft(id=i + 100, tag_name=f"v0.0.{i}", draft=False) for i in range(100)]
        draft = self.draft()
        server = GitHubServer(draft, releases=other_releases + [draft])
        with patch("urllib.request.urlopen", side_effect=server):
            self.github.stage(self.root, SHA, self.artifacts())
        self.assertEqual(server.reads[:2], ["releases?per_page=100&page=1", "releases?per_page=100&page=2"])
        self.assertEqual(len(server.writes), 2)

    def test_multiple_matching_releases_on_later_page_prevent_all_writes(self):
        for duplicate in (self.draft(id=43), self.draft(id=43, draft=False)):
            other_releases = [self.draft(id=i + 100, tag_name=f"v0.0.{i}") for i in range(99)]
            server = GitHubServer(releases=[self.draft(), *other_releases, duplicate])
            with self.subTest(duplicate=duplicate), patch("urllib.request.urlopen", side_effect=server), self.assertRaises(release.ReleaseError):
                self.github.stage(self.root, SHA, self.artifacts())
            self.assertEqual(server.writes, [])
            shutil.rmtree(self.root / "artifacts")

    def test_staging_rejects_orphan_tag_before_creating_draft(self):
        server = GitHubServer(tag={"object": {"type": "commit", "sha": SHA}})
        with patch("urllib.request.urlopen", side_effect=server), self.assertRaises(release.ReleaseError):
            self.github.stage(self.root, SHA, self.artifacts())
        self.assertEqual(server.writes, [])

    def test_invalid_listing_and_failed_pages_prevent_all_release_writes(self):
        failures = [None, {}, "", [None], [{}], [{"tag_name": None}],
                    urllib.error.HTTPError("url", 404, "Not Found", {}, None),
                    urllib.error.HTTPError("url", 403, "Forbidden", {}, None),
                    urllib.error.HTTPError("url", 500, "Server error", {}, None),
                    urllib.error.URLError("private-token"), TimeoutError(), ValueError("invalid JSON")]
        directory = self.artifacts()
        for failure in failures:
            for failed_page in (1, 2):
                server = GitHubServer(releases=[self.draft(id=i + 100, tag_name=f"v0.0.{i}") for i in range(100)])
                def respond(request, **kwargs):
                    if urllib.parse.parse_qs(urllib.parse.urlparse(request.full_url).query).get("page") == [str(failed_page)]:
                        if isinstance(failure, Exception):
                            raise failure
                        return Response(failure)
                    return server(request, **kwargs)
                with self.subTest(failure=failure, page=failed_page), patch("urllib.request.urlopen", side_effect=respond):
                    with self.assertRaises(release.ReleaseError) as caught:
                        self.github.stage(self.root, SHA, directory)
                    self.assertNotIn("private-token", str(caught.exception))
                self.assertEqual(server.writes, [])

    def test_stage_creates_draft_and_uploads_exactly_both_installers(self):
        directory = self.artifacts()
        server = GitHubServer()
        with patch("urllib.request.urlopen", side_effect=server):
            self.github.stage(self.root, SHA, directory)
        self.assertEqual([method for method, _, _ in server.writes], ["POST", "POST", "POST"])
        self.assertEqual(json.loads(server.writes[0][2]), {
            "tag_name": "v0.1.4", "target_commitish": SHA, "name": "v0.1.4", "draft": True})
        self.assertEqual({asset["name"] for asset in server.draft["assets"]},
                         {"Jump_0.1.4_aarch64.dmg", "Jump_0.1.4_x64-setup.exe"})
        self.assertTrue(server.draft["draft"])
        self.assertIn("releases/42", server.reads)
        self.assertFalse(any(path.startswith("releases/tags/") for path in server.reads))

    def test_stage_existing_empty_draft_never_replaces_or_publishes(self):
        directory = self.artifacts()
        server = GitHubServer(self.draft())
        with patch("urllib.request.urlopen", side_effect=server):
            self.github.stage(self.root, SHA, directory)
            with self.assertRaises(release.ReleaseError):
                self.github.stage(self.root, SHA, directory)
        self.assertEqual(len(server.writes), 2)
        self.assertTrue(all(path == "releases/42/assets" for _, path, _ in server.writes))

    def test_stage_rechecks_state_before_upload(self):
        directory = self.artifacts()
        for existing in (False, True):
            for changes in ({"assets": [{"name": "concurrent-upload"}]}, {"draft": False},
                            {"target_commitish": OTHER_SHA}, {"tag_name": "v0.1.3"}):
                server = GitHubServer(self.draft() if existing else None)
                def change(server):
                    if server.reads[-1] == "releases/42":
                        server.draft.update(changes)
                server.change_on_get = change
                with self.subTest(existing=existing, changes=changes), patch("urllib.request.urlopen", side_effect=server), self.assertRaises(release.ReleaseError):
                    self.github.stage(self.root, SHA, directory)
                self.assertEqual([path for _, path, _ in server.writes], [] if existing else ["releases"])

    def test_failed_id_recheck_prevents_uploads(self):
        directory = self.artifacts()
        for failure in (None, [], {}, urllib.error.HTTPError("url", 404, "Not Found", {}, None),
                        urllib.error.HTTPError("url", 403, "Forbidden", {}, None), urllib.error.URLError("private-token")):
            server = GitHubServer(self.draft())
            def respond(request, **kwargs):
                if urllib.parse.urlparse(request.full_url).path.endswith("/releases/42"):
                    if isinstance(failure, Exception):
                        raise failure
                    return Response(failure)
                return server(request, **kwargs)
            with self.subTest(failure=failure), patch("urllib.request.urlopen", side_effect=respond), self.assertRaises(release.ReleaseError):
                self.github.stage(self.root, SHA, directory)
            self.assertEqual(server.writes, [])

    def test_incomplete_or_modified_artifacts_prevent_any_release_write(self):
        mutations = [lambda d: shutil.rmtree(d / "windows"),
                     lambda d: (d / "macos/Jump_0.1.4_aarch64.dmg").write_bytes(b"changed"),
                     lambda d: (d / "unexpected.dmg").write_bytes(b"extra"),
                     lambda d: (d / "macos/app-notary.json").write_text(RECEIPT.replace("Accepted", "Invalid")),
                     lambda d: (d / "macos/verification.json").write_text('{}'),
                     lambda d: (d / "macos/candidate.json").write_text((d / "macos/candidate.json").read_text().replace(SHA, OTHER_SHA))]
        for mutate in mutations:
            with self.subTest(mutation=mutate):
                directory = self.artifacts()
                mutate(directory)
                server = GitHubServer()
                with patch("urllib.request.urlopen", side_effect=server), self.assertRaises((release.ReleaseError, OSError)):
                    self.github.stage(self.root, SHA, directory)
                self.assertEqual(server.writes, [])
                shutil.rmtree(directory)

    def test_preflight_requires_dispatch_main_and_exact_version(self):
        for ref, event, version in (("refs/heads/feature", "workflow_dispatch", "0.1.4"),
                                    ("refs/heads/main", "push", "0.1.4"),
                                    ("refs/heads/main", "workflow_dispatch", "0.1.3")):
            with patch.object(release, "ROOT", self.root), patch.dict(os.environ, {"GITHUB_REF": ref, "GITHUB_EVENT_NAME": event}), \
                 patch.object(sys, "argv", ["release.py", "preflight", "--sha", SHA, "--confirm-version", version]), \
                 patch("urllib.request.urlopen") as network, self.assertRaises(release.ReleaseError):
                release.main()
            network.assert_not_called()

    def test_preflight_and_default_guard_do_not_claim_to_check_drafts(self):
        env = {"GITHUB_REF": "refs/heads/main", "GITHUB_EVENT_NAME": "workflow_dispatch",
               "GITHUB_REPOSITORY": "owner/jump", "GH_TOKEN": "private-token"}
        for command in ("preflight", "guard"):
            server = GitHubServer(self.draft(assets=[{"name": "existing"}]))
            output = io.StringIO()
            with self.subTest(command=command), patch.object(release, "ROOT", self.root), patch.dict(os.environ, env, clear=True), \
                 patch.object(sys, "argv", ["release.py", command, "--sha", SHA, "--confirm-version", "0.1.4"]), \
                 patch("urllib.request.urlopen", side_effect=server), patch("sys.stdout", output):
                release.main()
            self.assertEqual(server.reads, ["releases/tags/v0.1.4", "git/ref/tags/v0.1.4"])
            self.assertIn("Drafts require the write-token staging check", output.getvalue())
            self.assertEqual(server.writes, [])

    def test_invalid_windows_payload_prevents_staging_even_with_matching_checksum(self):
        directory = self.artifacts()
        candidate = release.Candidate.for_platform(self.root, SHA, "windows")
        installer = directory / "windows" / candidate.installer
        installer.write_bytes(b"MZnot an installer")
        release.record_candidate(candidate, installer.parent)
        server = GitHubServer()
        with patch("urllib.request.urlopen", side_effect=server), self.assertRaises(release.ReleaseError):
            self.github.stage(self.root, SHA, directory)
        self.assertEqual(server.writes, [])


class MacTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / "package.json").write_text('{"version":"0.1.4"}')
        (self.root / "src-tauri").mkdir()
        (self.root / "scripts").mkdir()
        shutil.copy2(release.ROOT / "scripts/release-entitlements.plist", self.root / "scripts/release-entitlements.plist")
        (self.root / "src-tauri/tauri.conf.json").write_text(json.dumps({"bundle": {
            "resources": {"../LICENSE": "licenses/LICENSE", "../NOTICE": "licenses/NOTICE"},
            "macOS": {"minimumSystemVersion": "13.0"}}}))
        (self.root / "LICENSE").write_bytes(b"license bytes\n")
        (self.root / "NOTICE").write_bytes(b"notice bytes\n")
        self.app = self.root / "source/Jump.app"
        (self.app / "Contents/Resources/licenses").mkdir(parents=True)
        (self.app / "Contents/MacOS").mkdir()
        (self.app / "Contents/MacOS/jump").write_bytes(b"binary")
        shutil.copy2(self.root / "LICENSE", self.app / "Contents/Resources/licenses/LICENSE")
        shutil.copy2(self.root / "NOTICE", self.app / "Contents/Resources/licenses/NOTICE")
        self.info = {"CFBundleIdentifier": "com.nathanclairmonte.jump", "CFBundleShortVersionString": "0.1.4",
                     "CFBundleVersion": "0.1.4", "LSMinimumSystemVersion": "13.0", "CFBundleExecutable": "jump"}
        (self.app / "Contents/Info.plist").write_bytes(plistlib.dumps(self.info))
        self.candidate = release.Candidate.for_platform(self.root, SHA, "macos")
        self.dmg = self.root / self.candidate.installer
        self.dmg.write_bytes(b"image")
        self.commands = []
        self.entitlements = {}
        self.entitlement_warning = b""
        self.architecture = "arm64"
        self.signature = "Authority=Developer ID Application: Example (M59NWWY4WZ)\nTeamIdentifier=M59NWWY4WZ\nTimestamp=Oct 29, 2026\nCodeDirectory flags=0x10000(runtime)\n"
        self.assessment = "accepted\nsource=Notarized Developer ID\n"
        self.status = "assessments enabled"
        self.fail_staple = False
        self.mount_path = None
        self.applications_target = "/Applications"

    def tool(self, command, **kwargs):
        self.commands.append(command)
        stdout = b""
        if command[:2] == ["hdiutil", "attach"]:
            self.assertIn("-readonly", command)
            self.mount_path = Path(command[command.index("-mountpoint") + 1])
            shutil.copytree(self.app, self.mount_path / "Jump.app")
            if self.applications_target:
                (self.mount_path / "Applications").symlink_to(self.applications_target)
        elif command[:2] == ["spctl", "--status"]:
            stdout = self.status.encode()
        elif command[:2] == ["spctl", "--assess"]:
            stdout = self.assessment.encode()
        elif command[:2] == ["lipo", "-archs"]:
            stdout = self.architecture.encode()
        elif command[:3] == ["codesign", "--display", "--verbose=4"]:
            stdout = self.signature.encode()
        elif command[:3] == ["codesign", "--display", "--entitlements"]:
            stdout = plistlib.dumps(self.entitlements)
        elif command[:3] == ["xcrun", "stapler", "validate"] and self.fail_staple:
            raise release.ReleaseError("Missing staple")
        stderr = self.entitlement_warning if command[:3] == ["codesign", "--display", "--entitlements"] else b""
        return subprocess.CompletedProcess(command, 0, stdout, stderr)

    @contextmanager
    def native_tools(self):
        with patch.object(sys, "platform", "darwin"), patch.object(mac, "run", side_effect=self.tool):
            yield

    def test_complete_native_verification_checks_mounted_app_and_detaches(self):
        with self.native_tools():
            self.assertEqual(mac.verify(self.dmg, self.candidate, self.root), {"candidate": asdict(self.candidate), "verified": True})
        self.assertTrue(any(command[:4] == ["codesign", "--verify", "--strict", "--verbose=2"] and "--deep" in command and str(self.mount_path / "Jump.app") in command for command in self.commands))
        self.assertEqual(self.commands[-1], ["hdiutil", "detach", str(self.mount_path)])
        self.assertFalse(self.mount_path.exists())

    def test_native_verification_rejects_incomplete_security_evidence(self):
        mutations = [("signature", self.signature.replace("M59NWWY4WZ", "OTHERTEAM")),
                     ("signature", self.signature.replace("Authority=Developer ID Application:", "Authority=Apple Development:")),
                     ("signature", self.signature.replace("Timestamp=Oct 29, 2026\n", "")),
                     ("signature", self.signature.replace("runtime", "adhoc")),
                     ("assessment", "accepted\nsource=Developer ID\n"),
                     ("status", "assessments disabled"), ("architecture", "x86_64"),
                     ("entitlements", {"com.apple.security.get-task-allow": True}),
                     ("entitlement_warning", b"warning: binary contains an invalid entitlements blob"),
                     ("fail_staple", True)]
        for attribute, value in mutations:
            old = getattr(self, attribute)
            with self.subTest(attribute=attribute, value=value):
                setattr(self, attribute, value)
                self.commands.clear()
                with self.native_tools(), self.assertRaises(release.ReleaseError):
                    mac.verify(self.dmg, self.candidate, self.root)
                if any(command[:2] == ["hdiutil", "attach"] for command in self.commands):
                    self.assertEqual(self.commands[-1][:2], ["hdiutil", "detach"])
                setattr(self, attribute, old)

    def test_wrong_bundle_metadata_and_license_bytes_fail_and_detach(self):
        for key, value in (("CFBundleIdentifier", "other.app"), ("CFBundleShortVersionString", "0.1.3"),
                           ("CFBundleVersion", "0.1.3"), ("LSMinimumSystemVersion", "12.0")):
            (self.app / "Contents/Info.plist").write_bytes(plistlib.dumps({**self.info, key: value}))
            with self.subTest(key=key), self.native_tools(), self.assertRaises(release.ReleaseError):
                mac.verify(self.dmg, self.candidate, self.root)
            self.assertEqual(self.commands[-1][:2], ["hdiutil", "detach"])
        (self.app / "Contents/Info.plist").write_bytes(plistlib.dumps(self.info))
        (self.app / "Contents/Resources/licenses/NOTICE").write_bytes(b"different")
        with self.native_tools(), self.assertRaises(release.ReleaseError):
            mac.verify(self.dmg, self.candidate, self.root)
        self.assertEqual(self.commands[-1][:2], ["hdiutil", "detach"])

    def test_source_and_packaged_licenses_are_mandatory(self):
        mac.verify_licenses(self.root, self.app)
        (self.root / "NOTICE").unlink()
        with self.assertRaises(release.ReleaseError):
            mac.verify_licenses(self.root, self.app)
        (self.root / "NOTICE").write_bytes(b"notice bytes\n")
        (self.app / "Contents/Resources/licenses/NOTICE").unlink()
        with self.assertRaises(release.ReleaseError):
            mac.verify_licenses(self.root, self.app)

    def test_missing_or_incorrect_applications_link_fails_and_detaches(self):
        for target in (None, "/tmp"):
            self.applications_target = target
            with self.subTest(target=target), self.native_tools(), self.assertRaises(release.ReleaseError):
                mac.verify(self.dmg, self.candidate, self.root)
            self.assertEqual(self.commands[-1][:2], ["hdiutil", "detach"])

    def test_notarization_requires_accepted_receipt_and_saves_it(self):
        receipt = self.root / "receipt.json"
        for raw in (b'{}', b'not json', b'[]', RECEIPT.replace("Accepted", "Invalid").encode(),
                    RECEIPT.replace("Accepted", "In Progress").encode(), RECEIPT.replace("155bb6ab-0010-4d65-86d5-d9da6ca6f49a", "invalid").encode()):
            with self.subTest(raw=raw), patch.object(mac, "run", return_value=subprocess.CompletedProcess([], 0, raw, b"")):
                with self.assertRaises(release.ReleaseError):
                    mac.notarize(self.dmg, receipt, ["--password", "private-secret"])
                self.assertFalse(receipt.exists())
        with patch.object(mac, "run", return_value=subprocess.CompletedProcess([], 0, RECEIPT.encode(), b"")):
            mac.notarize(self.dmg, receipt, ["--keychain-profile", "existing-profile"])
        self.assertEqual(json.loads(receipt.read_text())["status"], "Accepted")

    def test_notarization_failure_reports_only_safe_submission_metadata(self):
        raw = RECEIPT.replace("Accepted", "Invalid").encode()
        with patch.object(mac, "run", return_value=subprocess.CompletedProcess([], 1, raw, b"private-secret")):
            with self.assertRaises(release.ReleaseError) as caught:
                mac.notarize(self.dmg, self.root / "receipt.json", ["--password", "private-secret"])
        self.assertIn("155bb6ab-0010-4d65-86d5-d9da6ca6f49a", str(caught.exception))
        self.assertIn("Invalid", str(caught.exception))
        self.assertNotIn("private-secret", str(caught.exception))

    def test_failed_attach_does_not_attempt_detach(self):
        with patch.object(mac, "run", side_effect=release.ReleaseError("Attach failed")) as native:
            with self.assertRaisesRegex(release.ReleaseError, "Attach failed"), mac.mounted(self.dmg):
                self.fail("The failed mount must not be exposed")
        self.assertEqual(native.call_count, 1)

    def test_detach_retries_and_preserves_the_verification_error(self):
        def native(command):
            if command[:2] == ["hdiutil", "detach"]:
                raise release.ReleaseError("Detach failed")
        mount = self.root / "stuck-mount"
        mount.mkdir()
        with patch.object(mac, "run", side_effect=native) as command, \
             patch.object(mac.tempfile, "mkdtemp", return_value=str(mount)), \
             patch.object(mac.shutil, "rmtree", side_effect=OSError("Read-only mounted volume")) as cleanup:
            with self.assertRaisesRegex(release.ReleaseError, "Verification failed"):
                with mac.mounted(self.dmg):
                    raise release.ReleaseError("Verification failed")
        cleanup.assert_not_called()
        self.assertEqual(command.call_args_list[-1].args[0][:3], ["hdiutil", "detach", "-force"])

    def test_subprocess_errors_never_include_secret_arguments_or_output(self):
        command = ["xcrun", "notarytool", "--password", "private-secret"]
        for failure in (subprocess.CompletedProcess(command, 1, b"private-secret", b"private-secret"),
                        OSError("private-secret")):
            with self.subTest(failure=failure):
                options = {"side_effect": failure} if isinstance(failure, OSError) else {"return_value": failure}
                with patch("subprocess.run", **options), self.assertRaises(release.ReleaseError) as caught:
                    mac.run(command)
                self.assertNotIn("private-secret", str(caught.exception))
                self.assertNotIn("--password", str(caught.exception))

    def test_missing_credentials_stop_before_build_or_output_creation(self):
        directory = self.root / "output"
        for env in ({}, {"APPLE_DEVELOPER_ID": IDENTITY, "APPLE_TEAM_ID": mac.TEAM},
                    {"APPLE_DEVELOPER_ID": IDENTITY, "APPLE_TEAM_ID": "OTHER", "NOTARY_KEYCHAIN_PROFILE": "existing"}):
            with patch.dict(os.environ, env, clear=True), patch.object(mac, "run") as native, self.assertRaises(release.ReleaseError):
                mac.build(self.candidate, directory)
            native.assert_not_called()
            self.assertFalse(directory.exists())

    def test_existing_profile_and_account_credentials_are_supported(self):
        env = {"APPLE_DEVELOPER_ID": IDENTITY, "APPLE_TEAM_ID": mac.TEAM, "NOTARY_KEYCHAIN_PROFILE": "existing"}
        self.assertEqual(mac.credentials(env), (IDENTITY, ["--keychain-profile", "existing"]))
        del env["NOTARY_KEYCHAIN_PROFILE"]
        env.update(APPLE_ID="private-account", APPLE_APP_SPECIFIC_PASSWORD="private-password")
        identity, auth = mac.credentials(env)
        self.assertEqual(identity, IDENTITY)
        self.assertIn("private-password", auth)

    def test_build_has_one_explicit_notarization_path_and_verifies_final_installer(self):
        directory = self.root / "output"
        build_app = self.root / "src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Jump.app"
        env = {"APPLE_DEVELOPER_ID": IDENTITY, "APPLE_TEAM_ID": mac.TEAM, "APPLE_ID": "private-account",
               "APPLE_APP_SPECIFIC_PASSWORD": "private-password", "APPLE_API_KEY": "api-key",
               "APPLE_API_ISSUER": "issuer", "APPLE_API_KEY_PATH": "private-path", "NOTARY_KEYCHAIN_PROFILE": "profile"}
        def tool(command, **kwargs):
            if command[0] == "bun":
                self.commands.append(command)
                self.assertEqual({key: value for key, value in kwargs["env"].items() if key.startswith(("APPLE_", "NOTARY_"))},
                                 {"APPLE_SIGNING_IDENTITY": IDENTITY})
                self.assertEqual(command[command.index("--bundles") + 1], "app")
                config = json.loads(command[command.index("--config") + 1])
                self.assertTrue(config["bundle"]["macOS"]["hardenedRuntime"])
                self.assertEqual(config["bundle"]["macOS"]["entitlements"], str(self.root / "scripts/release-entitlements.plist"))
                entitlements = plistlib.loads(Path(config["bundle"]["macOS"]["entitlements"]).read_bytes())
                self.assertIs(entitlements["com.apple.security.get-task-allow"], False)
                shutil.copytree(self.app, build_app)
            elif command[:3] == ["xcrun", "notarytool", "submit"]:
                self.commands.append(command)
                return subprocess.CompletedProcess(command, 0, RECEIPT.encode(), b"")
            elif command[0] == "ditto":
                self.commands.append(command)
                if "-c" in command:
                    Path(command[-1]).write_bytes(b"zip")
                else:
                    shutil.copytree(command[-2], command[-1])
            elif command[:2] == ["hdiutil", "create"]:
                self.commands.append(command)
                payload = Path(command[command.index("-srcfolder") + 1])
                self.assertEqual(os.readlink(payload / "Applications"), "/Applications")
                self.assertTrue((payload / "Jump.app").is_dir())
                Path(command[-1]).write_bytes(b"final DMG")
            else:
                return self.tool(command, **kwargs)
            return subprocess.CompletedProcess(command, 0, b"", b"")
        with patch.object(mac, "ROOT", self.root), patch.object(sys, "platform", "darwin"), \
             patch.dict(os.environ, env, clear=True), patch.object(mac, "run", side_effect=tool):
            mac.build(self.candidate, directory)
        submissions = [command for command in self.commands if command[:3] == ["xcrun", "notarytool", "submit"]]
        self.assertEqual(len(submissions), 2)
        self.assertTrue(submissions[0][3].endswith("Jump.app.zip"))
        self.assertEqual(submissions[1][3], str(directory / self.candidate.installer))
        staple_app = next(i for i, command in enumerate(self.commands) if command[:3] == ["xcrun", "stapler", "staple"])
        create_dmg = next(i for i, command in enumerate(self.commands) if command[:2] == ["hdiutil", "create"])
        self.assertLess(staple_app, create_dmg)
        signing = next(command for command in self.commands if command[:2] == ["codesign", "--sign"])
        self.assertIn("--timestamp", signing)
        self.assertEqual(json.loads((directory / "verification.json").read_text())["verified"], True)
        self.assertEqual(json.loads((directory / "candidate.json").read_text())["source_sha"], SHA)

    def test_rejected_app_submission_stops_before_packaging(self):
        directory = self.root / "output"
        build_app = self.root / "src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Jump.app"
        def tool(command, **kwargs):
            self.commands.append(command)
            if command[0] == "bun":
                shutil.copytree(self.app, build_app)
            if command[:3] == ["xcrun", "notarytool", "submit"]:
                return subprocess.CompletedProcess(command, 0, RECEIPT.replace("Accepted", "Invalid").encode(), b"")
            return subprocess.CompletedProcess(command, 0, b"", b"")
        env = {"APPLE_DEVELOPER_ID": IDENTITY, "APPLE_TEAM_ID": mac.TEAM, "NOTARY_KEYCHAIN_PROFILE": "existing"}
        with patch.object(mac, "ROOT", self.root), patch.object(sys, "platform", "darwin"), \
             patch.dict(os.environ, env, clear=True), patch.object(mac, "run", side_effect=tool), \
             patch.object(mac, "verify_signature"), self.assertRaises(release.ReleaseError):
            mac.build(self.candidate, directory)
        self.assertFalse(any(command[:2] == ["hdiutil", "create"] for command in self.commands))
        self.assertFalse((directory / "app-notary.json").exists())
        self.assertFalse((directory / "verification.json").exists())


class KeychainTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        security = self.bin / "security"
        security.write_text(f'''#!{sys.executable}
import os
from pathlib import Path
import sys
action = sys.argv[1]
if action == "create-keychain":
    Path(sys.argv[-1]).touch()
if action == "delete-keychain":
    Path(sys.argv[-1]).unlink()
print("private-secret-output")
print("private-secret-output", file=sys.stderr)
if action == os.environ.get("FAIL_ACTION"):
    sys.exit(1)
''')
        security.chmod(0o700)
        base64 = self.bin / "base64"
        base64.write_text(f'''#!{sys.executable}
import base64
import sys
sys.stdout.buffer.write(base64.b64decode(sys.stdin.buffer.read()))
''')
        base64.chmod(0o700)
        self.env = {**os.environ, "PATH": f"{self.bin}{os.pathsep}{os.environ['PATH']}", "RUNNER_TEMP": str(self.root),
                    "GITHUB_ENV": str(self.root / "github-env"), "APPLE_DEVELOPER_ID_P12_BASE64": "ZmFrZS1wMTI=",
                    "APPLE_DEVELOPER_ID_P12_PASSWORD": "private-p12-password", "APPLE_DEVELOPER_ID": IDENTITY,
                    "APPLE_ID": "private-id", "APPLE_APP_SPECIFIC_PASSWORD": "private-password", "APPLE_TEAM_ID": mac.TEAM}

    def execute(self, name, env):
        return subprocess.run(["sh", str(release.ROOT / "scripts" / name)], env=env, capture_output=True)

    def test_certificate_is_removed_after_success_or_import_failure_and_keychain_can_be_cleaned(self):
        for fail in ("", "import"):
            with self.subTest(failure=fail):
                result = self.execute("prepare-signing.sh", {**self.env, "FAIL_ACTION": fail})
                self.assertEqual(result.returncode, 1 if fail else 0)
                self.assertNotIn(b"private-secret-output", result.stdout + result.stderr)
                line = (self.root / "github-env").read_text().splitlines()[-1]
                signing_directory = Path(line.split("=", 1)[1])
                self.assertFalse((signing_directory / "certificate.p12").exists())
                self.assertTrue((signing_directory / "signing.keychain-db").exists())
                env = {**self.env, "JUMP_SIGNING_DIR": str(signing_directory)}
                cleanup = self.execute("cleanup-signing.sh", env)
                self.assertEqual(cleanup.returncode, 0, cleanup.stderr)
                self.assertFalse(signing_directory.exists())
                self.assertEqual(self.execute("cleanup-signing.sh", env).returncode, 0)

    def test_cleanup_refuses_an_outside_or_traversal_path(self):
        outside = self.root / "keep"
        outside.mkdir()
        sentinel = outside / "certificate.p12"
        sentinel.write_bytes(b"keep")
        for value in (str(outside), str(self.root / "jump-signing.fake/../keep")):
            result = self.execute("cleanup-signing.sh", {**self.env, "JUMP_SIGNING_DIR": value})
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(sentinel.read_bytes(), b"keep")

    def test_cleanup_refuses_a_valid_name_symlink_to_an_outside_directory(self):
        with tempfile.TemporaryDirectory() as outside:
            certificate = Path(outside) / "certificate.p12"
            certificate.write_bytes(b"keep certificate")
            keychain = Path(outside) / "signing.keychain-db"
            keychain.write_bytes(b"keep keychain")
            signing_directory = self.root / "jump-signing.fake"
            signing_directory.symlink_to(outside, target_is_directory=True)
            result = self.execute("cleanup-signing.sh", {**self.env, "JUMP_SIGNING_DIR": str(signing_directory)})
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(certificate.read_bytes(), b"keep certificate")
            self.assertEqual(keychain.read_bytes(), b"keep keychain")
            self.assertTrue(signing_directory.is_symlink())


if __name__ == "__main__":
    unittest.main()
