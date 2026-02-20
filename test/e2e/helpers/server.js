const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function toContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return CONTENT_TYPES[ext] || "application/octet-stream";
}

async function startFixtureServer(options = {}) {
  const fixturesDir =
    options.fixturesDir || path.resolve(__dirname, "..", "fixtures");

  const server = http.createServer(async (req, res) => {
    try {
      const reqUrl = new URL(req.url, "http://127.0.0.1");
      const relPath = reqUrl.pathname === "/" ? "/standard.html" : reqUrl.pathname;
      const safeRelPath = path.normalize(relPath).replace(/^([.][.][/\\])+/, "");
      const filePath = path.resolve(fixturesDir, `.${safeRelPath}`);

      if (!filePath.startsWith(fixturesDir)) {
        res.writeHead(403).end("Forbidden");
        return;
      }

      const body = await fs.readFile(filePath);
      res.writeHead(200, { "content-type": toContentType(filePath) });
      res.end(body);
    } catch (err) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end(`Not found: ${err.message}`);
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  return {
    baseURL: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    }),
  };
}

module.exports = {
  startFixtureServer,
};
