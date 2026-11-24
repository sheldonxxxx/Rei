// A real-world-ish article page: site chrome around the article, a cookie banner, a table, code, and scripts.
export const ARTICLE_URL = "https://travel.example.com/guides/kyoto-autumn?utm_source=news";

export const ARTICLE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Kyoto in Autumn: a Slow Guide | Example Travel</title>
  <meta name="description" content="When and where to see the maples.">
  <link rel="stylesheet" href="/static/site.css">
  <script>window.dataLayer = []; function track() { /* analytics */ }</script>
  <style>.banner { position: fixed } nav a { color: red }</style>
</head>
<body class="article">
  <div class="cookie-banner" style="display:none">We use cookies. Accept all cookies.</div>
  <header class="site-header">
    <a href="/" class="logo">Example Travel</a>
    <nav aria-label="Main"><ul><li><a href="/destinations">Destinations</a></li><li><a href="/deals">Deals</a></li><li><a href="/about">About us</a></li></ul></nav>
    <form action="/search"><input name="q" placeholder="Search"><button>Go</button></form>
  </header>
  <main>
    <article class="post">
      <h1>Kyoto in Autumn: a Slow Guide</h1>
      <p class="byline">By <a href="/authors/ana">Ana Ito</a> &middot; <time datetime="2026-10-03">3 October 2026</time></p>
      <p>Kyoto turns red and gold from <strong>mid November</strong> to early December. The crowds are real, but the city is built for walking, and the quiet lanes behind the big temples reward anyone who gets up early. This guide covers when to go, what to see, and how to avoid the queues that build around the most photographed gates.</p>
      <h2>When to go</h2>
      <p>Peak colour arrives around <em>20 November</em> in the city centre and a week earlier in the hills. See the <a href="/guides/kyoto-temples">temple guide</a> or the <a href="https://maps.example.org/kyoto?layer=foliage">foliage map</a> for the week-by-week forecast.</p>
      <ul>
        <li>Mid November: the hills (Kurama, Takao)</li>
        <li>Late November: central temples
          <ul><li>Eikando</li><li>Tofukuji</li></ul>
        </li>
        <li>Early December: the last colour at Daigoji</li>
      </ul>
      <h2>Entry fees</h2>
      <table>
        <thead><tr><th>Temple</th><th>Fee</th><th>Opens</th></tr></thead>
        <tbody>
          <tr><td>Kinkaku-ji</td><td>500 yen</td><td>09:00</td></tr>
          <tr><td>Eikando</td><td>1,000 yen</td><td>09:00</td></tr>
        </tbody>
      </table>
      <h2>Getting around</h2>
      <p>Buy a day pass for the bus, or rent a bicycle. A command to check the forecast from a terminal:</p>
      <pre><code class="language-bash">curl -s https://weather.example.net/kyoto.json | jq '.days[0]'</code></pre>
      <blockquote><p>The best view of Eikando is from the pond at 8:30, before the tour buses.</p></blockquote>
      <p>Tickets for the night illuminations sell out; book a week ahead. Bring a warm jacket, because evenings in late November drop to single digits and the temples are not heated.</p>
    </article>
    <aside class="related"><h3>Related</h3><ul><li><a href="/guides/osaka">Osaka in a weekend</a></li></ul></aside>
  </main>
  <footer><p>&copy; 2026 Example Travel. All rights reserved.</p><a href="/privacy">Privacy</a></footer>
  <script src="/static/app.js"></script>
</body>
</html>`;
