import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("publisher",ROOT/"deploy/publish-draft.py")
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)
features = (ROOT/publisher.FEATURES).read_bytes()


class PublisherTests(unittest.TestCase):
    def test_independent_discord_authorization(self):
        now = datetime.datetime.now(datetime.timezone.utc)
        admin,owner,other,room,msg = [str(i)*18 for i in range(1,6)]
        request = dict(actor=admin,channel=room,message=msg)
        entry = dict(id=msg,channel_id=room,type=0,author={"id":admin},content="انشر",timestamp=now.isoformat())
        guild={"owner_id":owner,"roles":[{"id":"r","permissions":"8"}]}
        responses={"/channels/"+room:{"guild_id":publisher.GUILD},f"/channels/{room}/messages/{msg}":entry,
                   "/guilds/"+publisher.GUILD:guild,f"/guilds/{publisher.GUILD}/members/{admin}":{"roles":["r"]}}
        def check():
            return publisher.authorized(request,responses.__getitem__,now)
        with patch.dict(os.environ,OPERATOR_ID=admin,OWNER_ID=owner):
            self.assertTrue(check())
            entry["content"]="someone said انشر"
            self.assertFalse(check())
            entry["content"]="انشر"
            entry["author"]["id"]=other
            self.assertFalse(check())
            entry["author"]["id"]=admin
            guild["roles"][0]["permissions"]="0"
            self.assertFalse(check())
            request["actor"]=entry["author"]["id"]=owner
            self.assertTrue(check())
            entry["timestamp"]=(now-datetime.timedelta(minutes=6)).isoformat()
            self.assertFalse(check())

    def test_fast_forward_conflict_and_idempotence(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)
            tree=path/"source"
            subprocess.run(["git","init","--quiet","-b","main",str(tree)],check=True)
            feature=tree/publisher.FEATURES
            feature.parent.mkdir()
            feature.write_bytes(features)
            subprocess.run(["git","-C",str(tree),"add","."],check=True)
            subprocess.run(["git","-C",str(tree),"-c","user.name=Test","-c","user.email=test@example.invalid",
                            "commit","--quiet","-m","Initial"],check=True)
            remote=path/"upstream.git"
            subprocess.run(["git","clone","--quiet","--bare",str(tree),str(remote)],check=True)
            changed=json.loads(features)
            changed["activity"]["top"]="# Test\n{rows}"
            request=dict(original=hashlib.sha256(features).hexdigest(),content=json.dumps(changed))
            with patch.object(publisher,"MIRROR",path/"cache.git"),patch.object(publisher,"REPO",str(remote)):
                revision=publisher.merge(request)
                self.assertEqual(revision,publisher.merge(request))
                only=subprocess.check_output(["git","--git-dir",str(remote),"diff","--name-only","HEAD~","HEAD"],text=True)
                self.assertEqual(only.strip(),publisher.FEATURES)
                request["content"]=features.decode()
                with self.assertRaises(publisher.PublishError): publisher.merge(request)
                request["content"]='{"commands":{"bad":"wrong"}}'
                with self.assertRaises(publisher.PublishError): publisher.merge(request)


if __name__=="__main__":
    unittest.main()
