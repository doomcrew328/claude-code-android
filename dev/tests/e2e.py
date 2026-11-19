"""Headless-Chrome field test: phone viewport, GPS mocked near Swan Hills, real Alberta data."""
import asyncio, json, os, sys
from playwright.async_api import async_playwright

URL = "http://127.0.0.1:8765/"
OUT = "/home/claude/shots"
os.makedirs(OUT, exist_ok=True)
START = {"latitude": 54.7166, "longitude": -115.4053, "accuracy": 6}   # Swan Hills


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path="/usr/bin/google-chrome", args=[
            "--no-sandbox", f"--proxy-server={os.environ['HTTPS_PROXY']}", "--proxy-bypass-list=127.0.0.1;localhost",
            "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"])
        ctx = await b.new_context(viewport={"width": 412, "height": 915}, device_scale_factor=2, is_mobile=True, has_touch=True,
                                  geolocation=START, permissions=["geolocation"], ignore_https_errors=True)
        pg = await ctx.new_page()
        logs = []
        pg.on("console", lambda m: logs.append(f"[{m.type}] {m.text}"))
        pg.on("pageerror", lambda e: logs.append(f"[pageerror] {e}"))
        await pg.goto(URL)
        await pg.wait_for_timeout(1200)
        await pg.screenshot(path=f"{OUT}/01_boot.png")
        await pg.wait_for_function("window.__LL && window.__LL.db && window.__LL.pos", timeout=30000)
        await pg.wait_for_timeout(5000)
        await pg.screenshot(path=f"{OUT}/02_home.png")
        st = await pg.evaluate("({lsd: document.querySelector('#roLsd').textContent, roads: window.__LL.roadsCount, chips: [...document.querySelectorAll('.chip')].map(c=>c.textContent)})")
        print("HOME", st)

        # search an LSD
        await pg.fill("#q", "100/11-04-068-10W5/00")
        await pg.wait_for_timeout(300)
        await pg.screenshot(path=f"{OUT}/03_suggest.png")
        await pg.press("#q", "Enter")
        await pg.wait_for_timeout(4500)
        await pg.screenshot(path=f"{OUT}/04_target.png")
        print("TARGET", await pg.evaluate("({label: document.querySelector('#tgLabel').textContent, dist: document.querySelector('#tgDist').textContent, brg: document.querySelector('#tgBrg').textContent, official: !!window.__LL.target.official, center: window.__LL.target.center})"))

        # route
        await pg.click("#bRoute")
        await pg.wait_for_function("window.__LL.route || document.querySelector('#toast:not(.hidden)')", timeout=60000)
        await pg.wait_for_timeout(2500)
        await pg.screenshot(path=f"{OUT}/05_route.png")
        r = await pg.evaluate("window.__LL.route && ({km: window.__LL.route.meters/1000, min: window.__LL.route.seconds/60, steps: window.__LL.route.steps.map(s=>s.km.toFixed(1)+' '+s.text), last: window.__LL.route.lastMile})")
        print("ROUTE", json.dumps(r, indent=1))
        print("TOAST", await pg.evaluate("document.querySelector('#toast').textContent"))

        # start nav and drive along the route
        await pg.click("#bStart")
        await pg.wait_for_timeout(1500)
        path = await pg.evaluate("window.__LL.route.path")
        idx = [int(len(path) * f) for f in (0.02, 0.1, 0.25, 0.4)]
        for i in idx:
            await ctx.set_geolocation({"latitude": path[i][1], "longitude": path[i][0], "accuracy": 5})
            await pg.wait_for_timeout(1300)
        await pg.wait_for_timeout(1500)
        await pg.screenshot(path=f"{OUT}/06_nav.png")
        print("NAV", await pg.evaluate("({d: mvDist.textContent, t: mvText.textContent, n: mvNext.textContent, rem: nvRem.textContent, along: nvAlong.textContent, odo: roOdo.textContent, lsd: roLsd.textContent})"))

        # go off-route to force an offline-capable reroute
        await ctx.set_offline(True)
        await pg.evaluate("window.dispatchEvent(new Event('offline'))")
        off = path[idx[-1]]
        for k in range(4):
            await ctx.set_geolocation({"latitude": off[1] + 0.004 + k * 0.0003, "longitude": off[0] + 0.004, "accuracy": 5})
            await pg.wait_for_timeout(1300)
        await pg.wait_for_timeout(4000)
        await pg.screenshot(path=f"{OUT}/07_reroute_offline.png")
        print("REROUTE", await pg.evaluate("({toast: document.querySelector('#toast').textContent, km: window.__LL.route && window.__LL.route.meters/1000, net: document.querySelector('#chipNet').textContent})"))

        # road log
        await pg.click("#bLog")
        await pg.wait_for_timeout(600)
        await pg.screenshot(path=f"{OUT}/08_roadlog.png")
        await pg.click(".sheetX")
        await pg.click("#bEnd")
        await ctx.set_offline(False)
        await pg.evaluate("window.dispatchEvent(new Event('online'))")

        # weather (mocked: the test sandbox can't reach Open-Meteo) + layers + zoomed grid
        wx = {"current":{"temperature_2m":-6.2,"apparent_temperature":-12.8,"wind_speed_10m":14,"wind_gusts_10m":31,"weather_code":71,"precipitation":0.2},
              "daily":{"time":["2026-11-16","2026-11-17","2026-11-18","2026-11-19","2026-11-20","2026-11-21"],"precipitation_sum":[0,1.2,3.4,0.6,0,2.1],"snowfall_sum":[0,0.8,2.6,0.4,0,1.5],
                       "temperature_2m_max":[-1,-3,-4,-5,-2,-7],"temperature_2m_min":[-9,-11,-12,-14,-10,-16],"weather_code":[3,71,73,71,2,73]}}
        await pg.route("https://api.open-meteo.com/**", lambda r: r.fulfill(status=200, content_type="application/json", body=json.dumps(wx)))
        await pg.evaluate("window.__LL.map.jumpTo({center:[-115.4662,54.8597], zoom:14.6, pitch:0, bearing:0})")
        await pg.wait_for_timeout(4000)
        await pg.click("#bWx")
        await pg.wait_for_timeout(2500)
        await pg.screenshot(path=f"{OUT}/10_wx.png")
        await pg.click(".sheetX")
        await pg.click("#bLayers")
        await pg.wait_for_timeout(300)
        await pg.screenshot(path=f"{OUT}/11_layers.png")
        await pg.click("[data-base=tac]")
        await pg.click(".sheetX")
        await pg.evaluate("window.__LL.map.jumpTo({center:[-115.45,54.83], zoom:13.4, pitch:0, bearing:0})")
        await pg.wait_for_timeout(5000)
        await pg.screenshot(path=f"{OUT}/12_tactical.png", timeout=60000)
        # record a track along a road, save, export
        await ctx.set_geolocation({"latitude": 54.8300, "longitude": -115.4500, "accuracy": 4})
        await pg.wait_for_timeout(800)
        await pg.click("#bRec")
        for k in range(1, 12):
            await ctx.set_geolocation({"latitude": 54.8300 + k*0.0004, "longitude": -115.4500 + k*0.0003, "accuracy": 4})
            await pg.wait_for_timeout(500)
        await pg.click("#bRec")
        await pg.wait_for_timeout(500)
        await pg.screenshot(path=f"{OUT}/13_savetrack.png")
        await pg.click("#trkSave")
        await pg.wait_for_timeout(800)
        print("TRACKS", await pg.evaluate("window.__LL.tracks.map(t=>t.name+' '+t.km.toFixed(2)+'km '+t.pts.length+'pts')"))
        # tap probe
        await pg.mouse.click(150, 420)
        await pg.wait_for_timeout(500)
        print("PROBE", await pg.evaluate("document.querySelector('#probe').innerText"))
        # SOS
        await pg.click("#bMenu"); await pg.click("#mSOS"); await pg.wait_for_timeout(400)
        await pg.screenshot(path=f"{OUT}/14_sos.png")
        await pg.click(".sheetX")
        # offline area save
        await pg.click("#bPacks"); await pg.wait_for_timeout(300)
        await pg.click("#pkSave"); await pg.wait_for_timeout(9000)
        await pg.screenshot(path=f"{OUT}/15_packs.png")
        print("PACKS", await pg.evaluate("window.__LL.packs"))
        print("\n".join(l for l in logs if 'pageerror' in l or '[error]' in l)[:3000])
        await b.close()

asyncio.run(main())
