#!/usr/bin/env python3
"""
Render Deployment Diagnostic & Log Inspector Tool (Python)
Queries Render REST API to inspect deploys and build failure events.
"""

import os
import sys
import json
import urllib.request
import urllib.error
from pathlib import Path

def load_env(env_path: Path):
    if not env_path.is_file():
        return
    with open(env_path, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            if '=' in line:
                key, val = line.split('=', 1)
                key = key.strip()
                val = val.strip().strip('"').strip("'")
                if key not in os.environ:
                    os.environ[key] = val

def main():
    root_dir = Path(__file__).resolve().parent.parent
    load_env(root_dir / ".env")

    api_key = os.environ.get("RENDER_API_KEY", "").strip()

    print("\n========================================================================")
    print("🚀 UNHOLD RENDER DEPLOYMENT DIAGNOSTICS (Python)")
    print("========================================================================")

    if not api_key or "your_render_api_key_here" in api_key:
        print("\n⚠️  RENDER_API_KEY is not configured in projects/unhold_paypal/.env\n")
        print("To connect to Render and inspect your deployment failure:")
        print("  1. Open your Render Account Settings:")
        print("     👉 https://dashboard.render.com/u/settings?add-api-key")
        print('  2. Click "Create API Key", name it "Unhold", and copy the token.')
        print("  3. Paste it into projects/unhold_paypal/.env:")
        print("     RENDER_API_KEY=rnd_xxxxxxxxxxxxxxxxxxxxxxxxxxxx")
        print("  4. Re-run: python3 scripts/render_diagnostics.py\n")
        print("Or paste the API key directly in the chat and Antigravity will diagnose it!")
        print("========================================================================\n")
        return

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Accept": "application/json"
    }

    try:
        print("\n[1/3] Authenticating with Render API...")
        req = urllib.request.Request("https://api.render.com/v1/services?limit=20", headers=headers)
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read().decode())

        services = [item.get("service", item) for item in data]
        print(f"✅ Found {len(services)} services in Render account.\n")

        if not services:
            print("No services found in this account.")
            return

        unhold_services = [
            s for s in services
            if "unhold" in s.get("name", "").lower() or "unhold" in s.get("repo", "").lower()
        ]
        target = unhold_services if unhold_services else services

        for s in target:
            sid = s.get("id")
            sname = s.get("name")
            stype = s.get("type")
            details = s.get("serviceDetails", {})
            print(f"------------------------------------------------------------------------")
            print(f"📦 Service: {sname} [ID: {sid}] ({stype})")
            print(f"   URL: {details.get('url', 'Pending')}")
            print(f"   Repo: {s.get('repo', 'N/A')} (Branch: {s.get('branch', 'main')})")

            print(f"\n[2/3] Fetching latest deploys for {sname}...")
            dep_req = urllib.request.Request(f"https://api.render.com/v1/services/{sid}/deploys?limit=5", headers=headers)
            with urllib.request.urlopen(dep_req) as dep_resp:
                deploys_raw = json.loads(dep_resp.read().decode())

            deploys = [d.get("deploy", d) for d in deploys_raw]
            if not deploys:
                print("   No deploys recorded yet.")
                continue

            latest = deploys[0]
            status = latest.get("status", "unknown")
            icon = "✅" if status == "live" else ("⏳" if "progress" in status else "🚨")

            print(f"   Latest Deploy ID: {latest.get('id')}")
            print(f"   Status: {icon} {status.upper()}")
            commit = latest.get("commit", {})
            if commit:
                print(f"   Commit: {commit.get('id', '')[:8]} - \"{commit.get('message', '')}\"")
            print(f"   Finished At: {latest.get('finishedAt')}")

            if status in ["build_failed", "update_failed"]:
                print(f"\n[3/3] 🚨 Fetching event logs for failed deploy...")
                ev_req = urllib.request.Request(f"https://api.render.com/v1/services/{sid}/events?limit=10", headers=headers)
                with urllib.request.urlopen(ev_req) as ev_resp:
                    events_raw = json.loads(ev_resp.read().decode())

                events = [e.get("event", e) for e in events_raw]
                for ev in events:
                    print(f"   [{ev.get('timestamp')}] {ev.get('type')}: {ev.get('details')}")

    except urllib.error.HTTPError as e:
        print(f"\n❌ Render API HTTP Error {e.code}: {e.read().decode()}")
    except Exception as e:
        print(f"\n❌ Diagnostic Error: {e}")

    print("\n========================================================================\n")

if __name__ == "__main__":
    main()
