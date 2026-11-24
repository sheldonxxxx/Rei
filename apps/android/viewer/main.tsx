import { useState } from "react";
import { createRoot } from "react-dom/client";
import { NativeDocument } from "../../web/src/components/NativeDocument.tsx";
import "../../web/src/index.css";
import "./viewer.css";

// The app sends only PDF and Office files here. Images, audio, video, HTML and plain text open in native screens, so the
// renderer carries none of those branches (and none of their blob URLs or iframes).
const name = new URLSearchParams(location.search).get("name") || "document";
const ext = name.split(".").at(-1)?.toLowerCase() || "";

function Preview({ bytes }: { bytes: ArrayBuffer }) {
  const [error, setError] = useState("");
  if (error) return <p role="alert">{error}</p>;
  if (/^(pdf|docx?|docm|dotx|xlsx?|xlsb|xlsm|xltx?|pptx?|ppsx?|potx|odt|ods|odp|rtf|csv|tsv)$/.test(ext))
    return <NativeDocument bytes={bytes} name={name} onError={setError} onLocation={() => {}} />;
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
