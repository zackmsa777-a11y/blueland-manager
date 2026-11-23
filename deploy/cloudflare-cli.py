#!/usr/bin/python3
"""Cloudflare commands for the BlueLand operator and Discord's read-only socket."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ACCOUNT = "9d9c5f95d34184d920fa7cd370eece40"
ZONE = "94f67256000779a9952645f5f03d79f8"
TUNNEL = "eefdd987-b0c8-497e-bb68-1dc48bed0db1"
DOMAIN = "najdhorizonco.shop"
BOT = "bot." + DOMAIN
GAMES = "games." + DOMAIN
ORIGIN = "http://127.0.0.1:4196"
TUNNEL_URL = f"/accounts/{ACCOUNT}/cfd_tunnel/{TUNNEL}"
CONFIG_URL = TUNNEL_URL + "/configurations"
DNS_URL = f"/zones/{ZONE}/dns_records"
TOKEN = Path("/etc/blueland-cloudflare/admin-token")
RULE = {"hostname": GAMES, "service": ORIGIN, "originRequest": {"httpHostHeader": GAMES}}
RECORD = {"name": GAMES, "type": "CNAME", "content": f"{TUNNEL}.cfargotunnel.com", "proxied": True, "ttl": 1}
READ_COMMANDS = ("status", "routes", "dns")


class CloudflareError(Exception):
    pass


def api(token, path, method="GET", payload=None):
    request = Request("https://api.cloudflare.com/client/v4" + path, method=method,
                      headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
                      data=None if payload is None else json.dumps(payload).encode())
    try:
        with urlopen(request, timeout=12) as response:
            data = json.load(response)
    except HTTPError as error:
        data = json.load(error)
    if not data.get("success"):
        codes = ", ".join(str(error.get("code", "?")) for error in data.get("errors", []))
        raise CloudflareError(f"Cloudflare API rejected the request ({codes}).")
    return data["result"]


def read_command(token, action):
    if action == "status":
        result = api(token, TUNNEL_URL)
        return {"name": result["name"], "status": result["status"]}
    if action == "routes":
        config = api(token, CONFIG_URL)["config"]
        return [{"host": rule["hostname"], "service": rule["service"], "path": rule.get("path", "")}
                for rule in config["ingress"] if rule.get("hostname") in (BOT, GAMES)]
    if action == "dns":
        return [{"host": record["name"], "type": record["type"], "proxied": record["proxied"]}
                for host in (BOT, GAMES) for record in api(token, DNS_URL + "?name=" + host)]
    raise CloudflareError("Supported commands: status, routes, dns.")


def games(token, expected=None):
    current = api(token, CONFIG_URL)
    config = current["config"]
    ingress = config["ingress"]
    bot = [rule for rule in ingress if rule.get("hostname") == BOT]
    if len(bot) != 1 or bot[0].get("service") != ORIGIN or not ingress[-1]["service"].startswith("http_status:"):
        raise CloudflareError("Unexpected bot ingress or catch-all; review the tunnel first.")
    route = [rule for rule in ingress if rule.get("hostname") == GAMES]
    if route and route != [RULE]:
        raise CloudflareError("A different games route already exists.")
    records = api(token, DNS_URL + "?name=" + GAMES)
    if len(records) > 1 or any(any(record.get(k) != RECORD[k] for k in RECORD) for record in records):
        raise CloudflareError("A different games DNS record already exists.")
    snapshot = hashlib.sha256(json.dumps([current.get("version"), config, records],
                                         sort_keys=True).encode()).hexdigest()
    if expected is None:
        return {"preview": snapshot, "add_route": None if route else RULE, "add_dns": None if records else RECORD,
                "preserved_route": BOT}
    if expected != snapshot:
        raise CloudflareError("Route or DNS changed since preview.")
    if not route:
        api(token, CONFIG_URL, "PUT", {"config": {**config, "ingress": [*ingress[:-1], RULE, ingress[-1]]}})
    if not records:
        api(token, DNS_URL, "POST", RECORD)
    updated = api(token, CONFIG_URL)["config"]["ingress"]
    if [r for r in updated if r.get("hostname") != GAMES] != [r for r in ingress if r.get("hostname") != GAMES]:
        raise CloudflareError("The saved ingress differs from the reviewed ingress.")
    if [r for r in updated if r.get("hostname") == GAMES] != [RULE]:
        raise CloudflareError("Cloudflare did not return the expected games route.")
    return {"games": GAMES, "preserved_route": BOT}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=(*READ_COMMANDS, "games", "serve"))
    parser.add_argument("--apply", metavar="PREVIEW")
    args = parser.parse_args()
    try:
        if args.command == "serve":
            command = sys.stdin.buffer.readline(32).decode().strip()
            if command not in READ_COMMANDS:
                raise CloudflareError("Supported commands: status, routes, dns.")
            token = Path(os.environ["CREDENTIALS_DIRECTORY"]) / "cloudflare-token"
            result = read_command(token.read_text().strip(), command)
        elif args.command == "games":
            result = games(TOKEN.read_text().strip(), args.apply)
        else:
            result = read_command(TOKEN.read_text().strip(), args.command)
        print(json.dumps(result), flush=True)
    except (CloudflareError, OSError, ValueError, KeyError) as error:
        print(json.dumps({"error": str(error) if isinstance(error, CloudflareError) else "Cloudflare request failed."}),
              flush=True)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
