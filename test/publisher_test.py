import datetime
import importlib.util
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
            request.update(op="confirm",preview="6"*18)
            entry.update(content="تأكيد",message_reference={"channel_id":room,"message_id":request["preview"]})
            self.assertTrue(check())
            entry["message_reference"]["message_id"]="7"*18
            self.assertFalse(check())
            entry["message_reference"]["message_id"]=request["preview"]
            entry["timestamp"]=(now-datetime.timedelta(minutes=6)).isoformat()
            self.assertFalse(check())

    def test_review_is_exact_and_either_operator_can_confirm(self):
        import sqlite3
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp); tree=path/"source"
            subprocess.run(["git","init","--quiet","-b","main",str(tree)],check=True)
            src=tree/"src/example.js";src.parent.mkdir();src.write_text("module.exports=1;\n")
            def local(*args):
                return subprocess.check_output(["git","-C",str(tree),*args]).decode().strip()
            local("add",".");local("-c","user.name=Test","-c","user.email=test@example.invalid","commit","--quiet","-m","Initial")
            base=local("rev-parse","HEAD")
            remote=path/"upstream.git"
            subprocess.run(["git","clone","--quiet","--bare",str(tree),str(remote)],check=True)
            src.write_text("module.exports=2;\n")
            draft=local("diff")+"\n"
            admin,owner="1"*18,"2"*18
            request=dict(op="preview",base=base,patch=draft,actor=admin,channel="room",message="3"*18)
            sent={};dms={};checked=[]
            def api(route,**kwargs):
                if route.startswith("/guilds/") and "/members/" in route: return {"roles":["admin"]}
                if route.startswith("/guilds/"): return {"owner_id":owner,"roles":[{"id":"admin","permissions":"8"}]}
                if route=="/users/@me/channels": return {"id":"dm"+kwargs["message"]["recipient_id"]}
                if route.startswith("/channels/dm"):
                    key=route.split("/")[2]
                    if kwargs:
                        filename,blob=kwargs["attachment"]
                        dms[key]=dict(id="copy",author={"id":publisher.BOT},content=kwargs["message"]["content"],
                                      attachments=[{"id":"attachment","filename":filename}],diff=blob)
                    return dms[key]
                if kwargs: sent.update(id="review",author={"id":publisher.BOT},content=kwargs["message"]["content"])
                return sent
            approval=dict(channel="room",preview="review",actor=owner,message="confirmation")
            with patch.dict(os.environ,OPERATOR_ID=admin,OWNER_ID=owner),patch.object(publisher,"MIRROR",path/"cache.git"),patch.object(publisher,"STATE",path),patch.object(publisher,"REPO",str(remote)),sqlite3.connect(":memory:") as db:
                publisher.database(db);publisher.preview(db,request,api,100)
                self.assertIn(b"+module.exports=2;",dms["dm"+owner]["diff"])
                self.assertEqual(dms["dm"+admin]["diff"],dms["dm"+owner]["diff"])
                self.assertEqual(publisher.refresh(),base)
                rev=db.execute("SELECT revision FROM app_reviews").fetchone()[0]
                src.write_text("module.exports=3;\n")
                def tests(sha):
                    checked.append(sha)
                    self.assertEqual(publisher.git(["show",sha+":src/example.js"]),b"module.exports=2;\n")
                    return {"ok":True}
                with self.assertRaises(publisher.PublishError):
                    publisher.confirm(db,dict(approval,channel="other"),api,110,tests,lambda:True)
                with self.assertRaises(publisher.PublishError):
                    publisher.confirm(db,approval,api,2000,tests,lambda:True)
                with self.assertRaises(publisher.PublishError):
                    publisher.confirm(db,approval,api,110,lambda _:{"ok":False,"detail":"failed"},lambda:True)
                self.assertEqual(publisher.refresh(),base)
                sent["edited_timestamp"]="2026"
                with self.assertRaises(publisher.PublishError): publisher.confirm(db,approval,api,110,tests,lambda:True)
                del sent["edited_timestamp"]
                with self.assertRaises(publisher.PublishError): publisher.confirm(db,approval,api,110,tests,lambda:False)
                self.assertEqual(publisher.refresh(),base)
                result=publisher.confirm(db,approval,api,110,tests,lambda:True)
                self.assertEqual(result["revision"],rev)
                self.assertEqual(publisher.refresh(),rev);self.assertEqual(checked,[rev,rev])
                self.assertEqual(publisher.confirm(db,approval,api,112,tests,lambda:True),result)
                self.assertEqual((path/"wanted").read_text().strip(),rev)
                with self.assertRaises(publisher.PublishError): publisher.candidate(base,draft)


if __name__=="__main__":
    unittest.main()
