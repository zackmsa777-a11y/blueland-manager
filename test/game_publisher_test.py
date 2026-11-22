import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


@unittest.skipUnless(sys.platform == "linux", "production publisher uses Linux")
class PublisherTest(unittest.TestCase):
    def test_review_test_and_push_use_identical_content(self):
        path = Path(__file__).resolve().parents[1]/"deploy/game-publisher.py"
        spec = importlib.util.spec_from_file_location("publisher",path)
        tool = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(tool)
        with tempfile.TemporaryDirectory() as temp:
            repo = Path(temp)/"source"
            bare = Path(temp)/"mirror.git"
            origin = Path(temp)/"origin.git"
            def git(*args):
                return subprocess.check_output(["git",*args],text=True).strip()
            git("init","-q","-b","main",str(repo))
            name = "src/commands.js"
            (repo/name).parent.mkdir()
            (repo/name).write_text("const title = 'game';\n")
            old = "src/obsolete.js"
            new = "src/commands/hello.js"
            (repo/old).write_text("module.exports = 1;")
            git("-C",str(repo),"add",".")
            git("-C",str(repo),"-c","user.name=test","-c","user.email=test@localhost","commit","-qm","base")
            git("clone","-q","--bare",str(repo),str(origin))
            git("init","-q","--bare",str(bare))
            base = git("-C",str(repo),"rev-parse","HEAD")
            request = dict(room="22",base=base)
            def run(action,**params):
                return tool.handle(dict(request,action=action,**params))
            with patch.object(tool,"MIRROR",bare), patch.object(tool,"REMOTE",str(origin)), patch.object(tool,"test_revision") as checker:
                with self.assertRaises(ValueError): run("prepare",files={"../outside":"x"})
                content = "const title = 'BlueLand';\n"
                edits = {name:content,new:"module.exports = 'hello';\n",old:None}
                for bad in ("deploy/release.py", "src/../../.github/workflows/x.yml", "src/node_modules/discord.js"):
                    with self.assertRaises(ValueError): run("prepare",files={bad:"x"})
                head = run("prepare",files=edits)["head"]
                self.assertEqual(git("--git-dir",str(origin),"rev-parse","main"),base)
                self.assertIn("+const title = 'BlueLand'",run("diff",head=head)["patch"])
                checker.return_value = {"ok":False,"detail":"failed"}
                with self.assertRaises(ValueError): run("publish",head=head)
                self.assertEqual(git("--git-dir",str(origin),"rev-parse","main"),base)
                checker.return_value = {"ok":True,"detail":"passed"}
                self.assertEqual(run("publish",head=head)["head"],head)
                checker.assert_called_with(head)
                self.assertEqual(git("--git-dir",str(origin),"rev-parse","main"),head)
                self.assertEqual(git("--git-dir",str(origin),"show",f"main:{name}"),content.strip())
                self.assertEqual(git("--git-dir",str(origin),"show",f"main:{new}"),edits[new].strip())
                self.assertEqual(git("--git-dir",str(origin),"ls-tree","main","--",old),"")
                self.assertEqual(run("publish",head=head)["head"],head)
                with self.assertRaises(ValueError): run("prepare",files={name:content})


if __name__ == "__main__":
    unittest.main()
