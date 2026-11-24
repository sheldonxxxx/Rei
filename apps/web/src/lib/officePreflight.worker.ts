import { inspectSavedSpreadsheet, prepareOfficePreview } from "./officePreflight.ts";

self.onmessage = async (event: MessageEvent<{ bytes: ArrayBuffer; name: string }>) => {
  try {
    let result = prepareOfficePreview(event.data.bytes, event.data.name);
    if (/\.(xls|xlt|xlsb|ods)$/i.test(event.data.name)) result = await inspectSavedSpreadsheet(result);
    self.postMessage({ result }, { transfer: [result.bytes] });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : "The document could not be parsed." });
  }
};
