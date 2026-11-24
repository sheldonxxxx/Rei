import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { NativeDocument } from "../../web/src/components/NativeDocument.tsx";
import "../../web/src/index.css";
import "./viewer.css";

const params = new URLSearchParams(location.search);
const name = params.get("name") || "document";
const type = params.get("type") || "application/octet-stream";
const ext = name.split(".").at(-1)?.toLowerCase() || "";

function Preview({ bytes }: { bytes: ArrayBuffer }) {
  const [error, setError] = useState("");
  const [blob, setBlob] = useState("");
  const [source, setSource] = useState(false);
  useEffect(() => {
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    setBlob(url);
    return () => URL.revokeObjectURL(url);
  }, [bytes]);
  if (error) return <p role="alert">{error}</p>;
  if (type.startsWith("image/")) return <img src={blob} alt={name} />;
  // biome-ignore lint/a11y/useMediaCaption: Library media previews have only the uploaded original.
  if (type.startsWith("audio/")) return <audio src={blob} controls />;
  // biome-ignore lint/a11y/useMediaCaption: Library media previews have only the uploaded original.
  if (type.startsWith("video/")) return <video src={blob} controls />;
  if (type === "text/html" || ["html", "htm"].includes(ext)) {
    const html = new TextDecoder().decode(bytes);
    return (
      <>
        <button type="button" onClick={() => setSource(!source)}>
          {source ? "Rendered" : "Source"}
        </button>
        {source ? <pre>{html}</pre> : <iframe sandbox="" title={name} srcDoc={html} />}
      </>
    );
  }
  if (/^(pdf|docx?|docm|dotx|xlsx?|xlsb|xlsm|xltx?|pptx?|ppsx?|potx|odt|ods|odp|rtf|csv|tsv)$/.test(ext))
    return <NativeDocument bytes={bytes} name={name} onError={setError} onLocation={() => {}} />;
  if (type.startsWith("text/") || /^(md|mdx|json|jsonl|log|xml|yaml|yml|js|ts|py|kt|sh)$/.test(ext))
    return <pre>{new TextDecoder().decode(bytes.slice(0, 2 * 1024 * 1024))}</pre>;
  return <p>This format has no preview. Download the original from Versions.</p>;
}

const root = createRoot(document.getElementById("root")!);
if (matchMedia("(prefers-color-scheme: dark)").matches) document.documentElement.dataset.scheme = "dark";
fetch("/document-bytes")
  .then(async (response) => {
    if (!response.ok) throw new Error("Could not open this document.");
    root.render(<Preview bytes={await response.arrayBuffer()} />);
  })
  .catch(() => root.render(<p role="alert">Could not open this document.</p>));
