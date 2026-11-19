import asyncio
from playwright.async_api import async_playwright
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        pg = await b.new_page(viewport={'width':512,'height':512})
        await pg.goto('file:///home/claude/scripts/icon.html')
        await pg.locator('#s').screenshot(path='/home/claude/app/icons/icon-512.png')
        await pg.locator('#s').screenshot(path='/home/claude/app/icons/icon-maskable-512.png')
        await b.close()
asyncio.run(main())
