function fixtureUrl(baseURL, fixturePath) {
  const normalized = fixturePath.replace(/^\/+/, "");
  return `${baseURL}/${normalized}`;
}

async function openFixturePage(context, baseURL, fixturePath) {
  const page = await context.newPage();
  await page.goto(fixtureUrl(baseURL, fixturePath));
  await page.bringToFront();
  await page.waitForLoadState("networkidle");
  return page;
}

module.exports = {
  openFixturePage,
  fixtureUrl,
};
