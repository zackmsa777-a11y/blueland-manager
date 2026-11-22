import importlib.util
from contextlib import closing
import json
import os
from pathlib import Path
import tempfile
import sys
import unittest
from unittest.mock import patch
from types import SimpleNamespace

path = Path(__file__).resolve().parents[1] / "deploy/hermes-release/__init__.py"
spec = importlib.util.spec_from_file_location("release_plugin",path)
plugin = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = plugin
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

    def test_new_module_and_deletion_follow_the_room_draft(self):
        root = Path(self.tmp.name)
        live = root/self.base
        (live/"src").mkdir(parents=True)
        (live/"src/commands.js").write_text("old\n")
        (live/"package.json").write_text("{}")
        new = "src/commands/hello.js"
        def call(action,**args):
            return plugin.bot_code(dict(action=action,**args),"101","22","discord")
        with patch.object(plugin,"ROOT",root),patch.object(plugin,"status",return_value=self.state):
            self.assertIn("src/commands.js",call("list")["files"])
            self.assertEqual(call("read",path="package.json")["content"],"{}")
            with self.assertRaises(ValueError): call("create",path="package.json",content="{}")
            with self.assertRaises(ValueError): call("create",path="src/commands.js",content="new")
            for path in ("../auth.json","src/../deploy/hooks.js","src/.git/hooks.js","src/node_modules/x.js",
                         "src//file.js","/src/a.js","src/a\\b.js","deploy/hermes-release/__init__.py"):
                with self.assertRaises(ValueError): call("create",path=path,content="x")
            saved = call("create",path=new,content="one\ntwo\n")
            self.assertIn(new,call("list")["files"])
            self.assertEqual(call("read",path=new,start_line=2,line_count=1)["content"],"two\n")
            with self.assertRaises(ValueError): call("delete",path=new,sha256="stale")
            call("delete",path=new,sha256=saved["sha256"])
            self.assertNotIn(new,call("list")["modified"])
            seen = call("read",path="src/commands.js")
            call("delete",path=seen["path"],sha256=seen["sha256"])
            self.assertNotIn(seen["path"],call("list")["files"])
            self.assertEqual((live/seen["path"]).read_text(),"old\n")
            call("create",path=seen["path"],content="old\n")
            self.assertEqual(call("list")["modified"],[])

    def test_room_edits_review_and_native_confirmation(self):
        root = Path(self.tmp.name)
        name = "src/commands.js"
        for sha, content in [(self.base,"old line"),(self.head,"new line")]:
            file = root/sha/name
            file.parent.mkdir(parents=True)
            file.write_text(content)
        operations = []
        def worker(action, room, base, **args):
            operations.append(action)
            self.assertEqual((room,base),("22",self.base))
            if action == "prepare":
                self.assertEqual(args["files"],{name:"new line"})
                return {"head":self.head,"files":[name]}
            self.assertEqual(args["head"],self.head)
            return {"page":1,"pages":1,"patch":"-old line\n+new line"} if action=="diff" else {"head":self.head}
        def edit(params, actor="101", room="22"):
            return plugin.bot_code(params,actor,room,"discord")
        with patch.object(plugin,"ROOT",root), patch.object(plugin,"status",side_effect=lambda:self.state.copy()), \
             patch.object(plugin,"github",return_value={"sha":self.base}), patch.object(plugin,"publisher",side_effect=worker), \
             patch.object(plugin,"can_publish",return_value=True), patch.object(plugin.subprocess,"run") as start:
            read = {"action":"read","path":name}
            for invalid in [dict(read,path="../.env"),dict(read,path="deploy/release.py")]:
                with self.assertRaises(ValueError): edit(invalid)
            with self.assertRaises(ValueError): edit(read,actor="other")
            data = edit(read)
            change = dict(action="replace",path=name,old="old",new="new",sha256=data["sha256"])
            edit(change)
            self.assertEqual(edit(read,room="23")["content"],"old line")
            with self.assertRaises(ValueError): edit(change)
            shown = plugin.preview("102","22","discord")
            self.assertIn("new line",plugin.describe(shown))
            source = SimpleNamespace(user_id="102",chat_id="22")
            self.assertIn("old line",plugin.command("diff 1",source=source,platform="discord"))
            # A later edit invalidates the preview even if its SHA prefix is reused.
            edit(dict(change,old="new",new="next",sha256=edit(read)["sha256"]))
            with self.assertRaises(ValueError): plugin.confirm("102","22","discord",self.head[:12])
            edit(dict(change,old="next",new="new",sha256=edit(read)["sha256"]))
            plugin.preview("101","22","discord")
            def activate(args,**kw):
                self.assertEqual(operations[-1],"publish")
                self.assertEqual(args[-1],"blueland-release@"+self.head+".service")
                self.state["live"] = self.head
                return plugin.subprocess.CompletedProcess(args,0)
            start.side_effect=activate
            self.assertIn(self.head[:12],plugin.command("confirm "+self.head[:12],source=source,platform="discord"))
            self.assertEqual(edit(read)["content"],"new line")
            with closing(plugin.reviews()) as db:
                self.assertEqual(db.execute("SELECT COUNT(*) FROM game_files").fetchone()[0],0)

if __name__ == "__main__":
    unittest.main()
