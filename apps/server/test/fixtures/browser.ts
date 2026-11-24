import { createServer } from "node:http";

export const ACTION_FAILURES = `<!doctype html><title>Action failures</title>
<button id="covered" style="position:fixed;left:20px;top:100px">Submit</button>
<div id="notice" class="cookie-banner visible excess" data-note="omit this"
     style="position:fixed;left:0;top:85px;width:300px;height:60px;background:white">We use cookies</div>
<button id="hide" onclick="document.querySelector('#hidden').style.display='none'">Hide button</button>
<button id="hidden">Hide me</button>
<button disabled>Disabled</button>
<label>Size <select><option value="s">Small</option><option value="m">Medium</option><option value="l">Large</option></select></label>`;

const PAGES = {
  "/upload": `<!doctype html><title>Upload fixture</title>
<input type="file" aria-label="Direct file">
<button id="choose">Choose file</button>
<button id="open">Open drawing</button>
<script>
  async function send(file) {
    const response = await fetch('/upload-receipt', {
      method: 'POST',
      headers: { 'x-file-name': file.name },
      body: file,
    });
    return response.text();
  }
  async function upload(event) {
    document.title = await send(event.currentTarget.files[0]);
  }
  document.querySelector('input').onchange = upload;
  document.querySelector('#choose').onclick = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.hidden = true;
    input.onchange = upload;
    document.body.append(input);
    input.click();
  };
  // Capture the method at page load as a site library can.
  const openFile = window.showOpenFilePicker.bind(window);
  document.querySelector('#open').onclick = async () => {
    try {
      const [handle] = await openFile({ types: [{ accept: { 'application/json': ['.json'] } }] });
      if (!(structuredClone(handle) instanceof FileSystemFileHandle)) throw new Error('Expected a native handle');
      document.title = await send(await handle.getFile()) + '|native handle';
    } catch (error) {
      document.title = error.name;
    }
  };
</script>`,
  "/refs": `<!doctype html><title>Refs</title>
<button onclick="document.title='main clicked'">Main action [ref=e99]</button>
<button onclick="history.pushState({}, '', '?next')">Push state</button>
<button onclick="document.querySelector('#changing').src='/child-two'">Change iframe</button>
<button onclick="this.remove()">Fresh document marker</button>
<iframe id="changing" src="/child-one" onload="document.title=this.contentDocument.title"></iframe>
<iframe src="/child-other"></iframe>`,
  "/refs/next": "<!doctype html><title>Other page</title><button>Other page</button>",
  "/child-one": "<!doctype html><title>Child one</title><button>Old frame action</button>",
  "/child-two":
    "<!doctype html><title>Child two</title><button onclick=\"parent.document.title='child clicked'\">New frame action</button>",
  "/child-other": "<!doctype html><title>Other child</title><button>Stable frame action</button>",
  "/waiting": `<!doctype html><title>Waiting</title>
<p id="loading">Preparing order</p>
<button id="confirm" disabled>Confirm order</button>
<button onclick="setTimeout(() => {
  document.querySelector('#loading').remove();
  document.querySelector('#confirm').disabled = false;
  document.body.append('Order placed');
}, 800)">Prepare order</button>
<button onclick="setTimeout(() => location.assign('/settled?step=done'), 850)">Go later</button>`,
  "/settle": `<!doctype html><title>Before navigation</title>
<a href="/settled" onclick="event.preventDefault();setTimeout(() => location.assign(this.href), 125)">Delayed link</a>
<button type="button">No change</button>
<form action="/settled" onsubmit="event.preventDefault();setTimeout(() => location.assign(this.action), 125)">
  <input aria-label="Search">
</form>`,
  "/settled": `<!doctype html><title>Settled</title><h1>Settled result</h1>
<img src="/settled-resource" alt="" onload="document.body.append('Resource loaded')">`,
  "/feed": `<!doctype html><title>Top of feed</title>
<main id="feed" style="position:fixed;inset:10vh 10vw;overflow:auto">
  <h1>Feed</h1><div style="height:1600px"></div>
  <button onclick="document.title='Clicked last row'">Last row</button>
</main>
<script>
  const feed = document.querySelector('#feed');
  feed.addEventListener('scroll', () => {
    document.title = feed.scrollTop === 0 ? 'Top of feed' : 'Scrolled feed';
    if (feed.scrollTop > 0 && !document.querySelector('#more')) {
      feed.insertAdjacentHTML('beforeend', '<p id="more">More rows loaded</p>');
    }
  });
</script>`,
  "/controls": `<!doctype html><title>0</title>
<style>
  #css-menu { display:none }
  #css-trigger:hover + #css-menu { display:block }
</style>
<button id="css-trigger">CSS trigger</button><div id="css-menu"><button>CSS menu item</button></div>
<button onpointerenter="document.querySelector('#js-menu').hidden=false">JS trigger</button>
<div id="js-menu" hidden><button>JS menu item</button></div>
<label><input type="checkbox" onchange="document.title=String(Number(document.title)+1)">Remember me</label>
<label><input type="radio" name="color" checked>Red</label>
<label><input type="radio" name="color">Blue</label>
<button role="switch" aria-checked="false" onclick="this.setAttribute('aria-checked', this.getAttribute('aria-checked') !== 'true')">Notifications</button>`,
  "/typing": `<!doctype html><title>Typing</title>
<input id="search" value="old" aria-label="Autocomplete">
<div role="button" tabindex="0" onkeydown="document.title+=event.key">Custom keyboard widget</div>
<button onclick="document.querySelector('#password').focus()">Focus password</button>
<input id="password" type="password" aria-label="Password" oninput="document.title='Password changed'">
<script>
  const input = document.querySelector('#search');
  const events = { inputs: [], keys: [] };
  input.addEventListener('input', () => {
    events.inputs.push(input.value);
    document.title = JSON.stringify(events);
  });
  input.addEventListener('keydown', (event) => events.keys.push(event.key));
</script>`,
};

export async function serveBrowserFixtures(): Promise<{ origin: string; close: () => Promise<void> }> {
  const pages = new Map(Object.entries(PAGES));
  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/upload-receipt") {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => res.end(`${req.headers["x-file-name"]}|${req.headers["content-type"]}|${body}`));
      return;
    }
    if (req.url === "/settled-resource") {
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "image/svg+xml" });
        res.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
      }, 250);
      return;
    }
    const page = pages.get(req.url?.split("?")[0] ?? "");
    res.writeHead(page === undefined ? 404 : 200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(page);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Could not start the browser fixture server");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}
