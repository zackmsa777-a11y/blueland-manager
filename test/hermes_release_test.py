import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

path = Path(__file__).resolve().parents[1] / "deploy/hermes-release/__init__.py"
spec = importlib.util.spec_from_file_location("release_plugin",path)
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)


class ReleaseTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.env = patch.dict(os.environ,HERMES_HOME=self.tmp.name,DISCORD_ALLOWED_USERS="101,102")
        self.env.start()
        self.addCleanup(self.env.stop)
        self.base, self.head = "a"*40, "b"*40
        self.state = {"live":self.base,"last_operation":"live","last_target":self.base,"updated":"now"}

    def test_real_active_path_can_include_a_previously_failed_target(self):
        root=Path(self.tmp.name)
        (root/self.base).mkdir()
        try:
            (root/"current").symlink_to(root/self.base,target_is_directory=True)
        except OSError:
            self.skipTest("directory symlinks unavailable")
        (root/"status.json").write_text(json.dumps(dict(phase="failed",active=self.base,target=self.head+"\n",updated="now")))
        with patch.object(plugin,"ROOT",root),patch.object(plugin,"github",return_value={"status":"ahead"}) as compare:
            data=plugin.status("94a58746c2b0")
        self.assertEqual(data["live"],self.base)
        self.assertEqual(data["last_target"],self.head)
        self.assertTrue(data["included_in_live"])
        self.assertIn("94a58746c2b0..."+self.base,compare.call_args.args[0])

    def test_confirm_checks_channel_revision_permissions_and_runs_only_the_pinned_service(self):
        new={**self.state,"live":self.head,"last_target":self.head}
        with patch.object(plugin,"status",side_effect=lambda: self.state.copy()),patch.object(plugin,"github",return_value={"sha":self.head}) as git,patch.object(plugin,"can_publish",return_value=True) as allowed,patch.object(plugin.subprocess,"run") as start:
            preview=plugin.preview("101","22","discord")
            self.assertIn(self.head[:12],preview["confirm"])
            for actor,room,sha in [("0","22",self.head),("102","21",self.head),("102","22","0"*12)]:
                with self.assertRaises(ValueError):
                    plugin.confirm(actor,room,"discord",sha)
            allowed.return_value=False
            with self.assertRaises(ValueError): plugin.confirm("102","22","discord",self.head)
            allowed.return_value=True
            git.return_value={"sha":"c"*40}
            with self.assertRaises(ValueError): plugin.confirm("102","22","discord",self.head)
            start.assert_not_called()
            git.return_value={"sha":self.head}
            def deploy(args,**opts):
                self.assertEqual(args,["/usr/bin/systemctl","--no-ask-password","start","blueland-release@"+self.head+".service"])
                self.state=new
                return plugin.subprocess.CompletedProcess(args,0)
            start.side_effect=deploy
            self.assertEqual(plugin.confirm("102","22","discord",self.head[:12])["live"],self.head)
            with self.assertRaises(ValueError): plugin.confirm("102","22","discord",self.head)

    def test_current_main_requires_no_confirmation_or_restart(self):
        with patch.object(plugin,"status",return_value=self.state.copy()),patch.object(plugin,"github",return_value={"sha":self.base}),patch.object(plugin.subprocess,"run") as start:
            self.assertNotIn("confirm",plugin.preview("101","22","discord"))
            start.assert_not_called()

if __name__ == "__main__":
    unittest.main()
