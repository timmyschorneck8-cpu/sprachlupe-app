const elements = {
  ask: document.querySelector("#ask"),
  camera: document.querySelector("#camera"),
  cameraLabel: document.querySelector("#camera-label"),
  cameraIndicator: document.querySelector("#camera-indicator"),
  cameraPlaceholder: document.querySelector("#camera-placeholder"),
  cameraStart: document.querySelector("#camera-start"),
  cameraStatus: document.querySelector("#camera-status"),
  cameraStop: document.querySelector("#camera-stop"),
  canvas: document.querySelector("#capture-canvas"),
  capturedImage: document.querySelector("#captured-image"),
  imageOverlays: document.querySelector("#image-overlays"),
  lineCount: document.querySelector("#line-count"),
  listen: document.querySelector("#listen"),
  query: document.querySelector("#query"),
  readText: document.querySelector("#read-text"),
  readTextLabel: document.querySelector("#read-text-label"),
  recognizedLines: document.querySelector("#recognized-lines"),
  recognize: document.querySelector("#recognize"),
  readingMode: document.querySelector("#reading-mode"),
  result: document.querySelector("#result"),
  searchCard: document.querySelector("#search-card"),
  searchForm: document.querySelector("#search-form"),
  selectAllLines: document.querySelector("#select-all-lines"),
  selectedLineCount: document.querySelector("#selected-line-count"),
  speechStatus: document.querySelector("#speech-status"),
  viewfinder: document.querySelector("#viewfinder"),
  zoom: document.querySelector("#zoom"),
  zoomValue: document.querySelector("#zoom-value"),
};

if (window.AndroidSpeechBridge) {
  document.querySelector("#android-download-row")?.setAttribute("hidden", "");
}

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const MIN_OCR_CONFIDENCE = 85;
const searchStopWords = new Set([
  "anlegen", "anzeigen", "bitte", "eintrag", "finden", "ich", "moechte",
  "möchte", "nach", "suche", "suchen", "such", "was",
]);

let cameraStream;
let recognizedLines = [];
let excludedOcrLineCount = 0;
let ocrWorkerPromise;
let tesseractScriptPromise;
let activeRecognition;
let isReadingText = false;

function setCameraStatus(message) {
  elements.cameraStatus.textContent = message;
}

function setSpeechStatus(message) {
  elements.speechStatus.textContent = message;
}

function speak(text) {
  if (window.AndroidSpeechBridge) {
    return new Promise((resolve) => {
      const requestId = `speech-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      window.__nativeSpeechCallbacks ??= {};
      window.__nativeSpeechCallbacks[requestId] = resolve;
      window.AndroidSpeechBridge.speak(text, requestId);
    });
  }

  if (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) {
    return Promise.resolve(false);
  }

  window.speechSynthesis.cancel();
  return new Promise((resolve) => {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "de-DE";
    utterance.rate = 0.9;
    utterance.onend = () => resolve(true);
    utterance.onerror = () => resolve(false);
    window.speechSynthesis.speak(utterance);
  });
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setCameraStatus("Dieser Browser unterstützt keinen Kamerazugriff. Öffne die App bitte in Safari oder Chrome.");
    return;
  }

  elements.cameraStart.disabled = true;
  setCameraStatus("Kamera wird gestartet …");

  try {
    if (window.AndroidSpeechBridge) {
      const cameraPermissionGranted = await new Promise((resolve) => {
        const requestId = `camera-${Date.now()}`;
        window.__nativePermissionCallbacks ??= {};
        window.__nativePermissionCallbacks[requestId] = resolve;
        window.AndroidSpeechBridge.requestPermission("camera", requestId);
      });
      if (!cameraPermissionGranted) {
        elements.cameraStart.disabled = false;
        setCameraStatus("Kein Kamerazugriff. Erlaube den Kamerazugriff in den Android-App-Einstellungen und versuche es erneut.");
        return;
      }
    }

    elements.searchCard.hidden = true;
    elements.result.hidden = true;
    elements.capturedImage.hidden = true;
    elements.imageOverlays.hidden = true;
    recognizedLines = [];
    elements.recognizedLines.replaceChildren();
    cameraStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1920 },
        height: { ideal: 1440 },
        focusMode: { ideal: "continuous" },
      },
    });
    elements.camera.srcObject = cameraStream;
    await elements.camera.play();
    elements.cameraPlaceholder.hidden = true;
    elements.camera.hidden = false;
    elements.cameraIndicator.classList.add("is-on");
    elements.cameraLabel.textContent = "Kamera an";
    elements.cameraStart.hidden = true;
    elements.cameraStop.hidden = false;
    elements.zoom.disabled = false;
    elements.recognize.disabled = false;
    setCameraStatus("Kamera bereit. Stelle den Text scharf und tippe auf „Text erkennen“.");
  } catch (error) {
    elements.cameraStart.disabled = false;
    const messages = {
      NotAllowedError: "Kein Kamerazugriff. Erlaube den Kamerazugriff in den Browser-Einstellungen und versuche es erneut.",
      NotFoundError: "Keine Kamera gefunden.",
      NotReadableError: "Die Kamera wird gerade von einer anderen App verwendet.",
    };
    setCameraStatus(messages[error.name] ?? "Die Kamera konnte nicht gestartet werden. Prüfe die Berechtigung und versuche es erneut.");
  }
}

function stopCamera() {
  cameraStream?.getTracks().forEach((track) => track.stop());
  cameraStream = undefined;
  elements.camera.srcObject = null;
  elements.camera.hidden = true;
  elements.cameraPlaceholder.hidden = false;
  elements.cameraIndicator.classList.remove("is-on");
  elements.cameraLabel.textContent = "Kamera aus";
  elements.cameraStart.hidden = false;
  elements.cameraStart.disabled = false;
  elements.cameraStop.hidden = true;
  elements.zoom.disabled = true;
  elements.recognize.disabled = true;
  setCameraStatus("Kamera beendet. Starte sie erneut, wenn du weiterarbeiten möchtest.");
}

function captureVisibleFrame() {
  const video = elements.camera;
  if (!cameraStream || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    throw new Error("Die Kamera ist noch nicht bereit. Warte kurz und versuche es erneut.");
  }

  const width = video.videoWidth;
  const height = video.videoHeight;
  const viewAspect = elements.viewfinder.clientWidth / elements.viewfinder.clientHeight;
  const sourceAspect = width / height;
  let cropWidth = width;
  let cropHeight = height;

  if (sourceAspect > viewAspect) {
    cropWidth = height * viewAspect;
  } else {
    cropHeight = width / viewAspect;
  }

  const zoom = Number(elements.zoom.value);
  cropWidth /= zoom;
  cropHeight /= zoom;
  const cropX = (width - cropWidth) / 2;
  const cropY = (height - cropHeight) / 2;

  elements.canvas.width = Math.round(cropWidth);
  elements.canvas.height = Math.round(cropHeight);
  const context = elements.canvas.getContext("2d");
  context.drawImage(video, cropX, cropY, cropWidth, cropHeight, 0, 0, elements.canvas.width, elements.canvas.height);
  return elements.canvas;
}

function loadTesseractScript() {
  if (window.Tesseract) return Promise.resolve();
  if (!tesseractScriptPromise) {
    tesseractScriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
      script.async = true;
      script.onload = () => window.Tesseract
        ? resolve()
        : reject(new Error("Die Texterkennung konnte nicht geladen werden. Lade die Seite neu."));
      script.onerror = () => {
        tesseractScriptPromise = undefined;
        reject(new Error("Die Texterkennung konnte nicht geladen werden. Prüfe die Internetverbindung und versuche es erneut."));
      };
      document.head.append(script);
    });
  }
  return tesseractScriptPromise;
}

async function getOcrWorker() {
  await loadTesseractScript();
  if (!window.Tesseract) {
    throw new Error("Die Texterkennung konnte nicht geladen werden. Prüfe die Internetverbindung und lade die Seite neu.");
  }

  if (!ocrWorkerPromise) {
    ocrWorkerPromise = window.Tesseract.createWorker("deu", 1, {
      logger: ({ status, progress }) => {
        if (status === "loading language traineddata") {
          const percent = Math.round((progress ?? 0) * 100);
          setCameraStatus(`Deutsches Sprachmodell wird geladen (${percent} %) …`);
        } else if (status === "recognizing text") {
          setCameraStatus(`Text wird erkannt (${Math.round((progress ?? 0) * 100)} %) …`);
        }
      },
    }).catch((error) => {
      ocrWorkerPromise = undefined;
      throw error;
    });
  }

  return ocrWorkerPromise;
}

function recognizeWithAndroid(canvas) {
  return new Promise((resolve, reject) => {
    const requestId = `ocr-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    window.__nativeOcrCallbacks ??= {};
    window.__nativeOcrCallbacks[requestId] = { resolve, reject };
    try {
      window.AndroidSpeechBridge.recognizeText(canvas.toDataURL("image/jpeg", 0.94), requestId);
    } catch (error) {
      delete window.__nativeOcrCallbacks[requestId];
      reject(error);
    }
  });
}

function textLinesFromResult(result) {
  const candidates = (result.lines ?? []).map((line) => ({
    text: line.text?.trim() ?? "",
    bbox: line.bbox,
    confidence: Number(line.confidence),
  }));
  const lines = candidates.filter((line) => (
    line.text
    && line.bbox
    && Number.isFinite(line.bbox.x0)
    && Number.isFinite(line.bbox.y0)
    && Number.isFinite(line.bbox.x1)
    && Number.isFinite(line.bbox.y1)
    && line.bbox.x1 > line.bbox.x0
    && line.bbox.y1 > line.bbox.y0
    && Number.isFinite(line.confidence)
    && line.confidence >= MIN_OCR_CONFIDENCE
  ));
  excludedOcrLineCount = candidates.length - lines.length;

  return lines.sort((first, second) => first.bbox.y0 - second.bbox.y0);
}

function renderRecognizedLines() {
  elements.recognizedLines.replaceChildren();
  for (const [index, line] of recognizedLines.entries()) {
    const item = document.createElement("li");
    item.value = index + 1;
    item.dataset.lineIndex = String(index);

    const label = document.createElement("label");
    label.className = "selectable-line";
    label.htmlFor = `select-line-${index}`;
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.id = `select-line-${index}`;
    checkbox.className = "line-selection-checkbox";
    checkbox.dataset.lineIndex = String(index);
    checkbox.checked = true;
    const text = document.createElement("span");
    text.textContent = line.text;
    label.append(checkbox, text);
    item.append(label);
    elements.recognizedLines.append(item);
  }
  elements.lineCount.textContent = `${recognizedLines.length} Zeilen`;
  updateTextSelection();
}

function updateTextSelection() {
  const checkboxes = [...elements.recognizedLines.querySelectorAll(".line-selection-checkbox")];
  const selectedCount = checkboxes.filter((checkbox) => checkbox.checked).length;
  const readingAll = getReadingMode() === "all";
  elements.selectAllLines.checked = checkboxes.length > 0 && selectedCount === checkboxes.length;
  elements.selectAllLines.indeterminate = selectedCount > 0 && selectedCount < checkboxes.length;
  elements.selectAllLines.disabled = readingAll || isReadingText;
  for (const checkbox of checkboxes) {
    checkbox.disabled = readingAll || isReadingText;
  }
  for (const radio of elements.readingMode.querySelectorAll('input[name="reading-mode"]')) {
    radio.disabled = isReadingText;
  }
  elements.selectedLineCount.textContent = readingAll
    ? `${checkboxes.length} Zeilen insgesamt`
    : `${selectedCount} von ${checkboxes.length} ausgewählt`;
  elements.readTextLabel.textContent = readingAll ? "Alles vorlesen" : "Auswahl vorlesen";
  elements.readText.disabled = isReadingText || checkboxes.length === 0 || (!readingAll && selectedCount === 0);
}

function getReadingMode() {
  return elements.readingMode.querySelector('input[name="reading-mode"]:checked')?.value ?? "selected";
}

function clearMatchHighlight() {
  elements.imageOverlays.replaceChildren();
  for (const item of elements.recognizedLines.children) {
    item.classList.remove("is-match");
  }
}

function highlightLine(lineIndex) {
  clearMatchHighlight();
  const line = recognizedLines[lineIndex];
  if (!line) return;

  const namespace = "http://www.w3.org/2000/svg";
  const rectangle = document.createElementNS(namespace, "rect");
  rectangle.setAttribute("class", "match-rect");
  rectangle.setAttribute("x", String(line.bbox.x0));
  rectangle.setAttribute("y", String(line.bbox.y0));
  rectangle.setAttribute("width", String(Math.max(4, line.bbox.x1 - line.bbox.x0)));
  rectangle.setAttribute("height", String(Math.max(4, line.bbox.y1 - line.bbox.y0)));
  elements.imageOverlays.append(rectangle);
  elements.imageOverlays.hidden = false;
  elements.recognizedLines.querySelector(`[data-line-index="${lineIndex}"]`)?.classList.add("is-match");
}

async function recognizeText() {
  elements.recognize.disabled = true;
  elements.readText.hidden = true;
  elements.readText.disabled = true;
  elements.result.hidden = true;
  elements.searchCard.hidden = true;
  clearMatchHighlight();

  try {
    setCameraStatus("Bild wird aufgenommen …");
    const canvas = captureVisibleFrame();
    elements.capturedImage.src = canvas.toDataURL("image/jpeg", 0.92);
    elements.capturedImage.hidden = false;
    elements.camera.hidden = true;
    elements.imageOverlays.setAttribute("viewBox", `0 0 ${canvas.width} ${canvas.height}`);
    elements.imageOverlays.hidden = true;

    let data;
    if (window.AndroidSpeechBridge) {
      setCameraStatus("Text wird mit der Android-Texterkennung gelesen …");
      try {
        data = await recognizeWithAndroid(canvas);
        if (!data.lines?.some((line) => line.text?.trim() && line.bbox)) {
          throw new Error("Die Android-Texterkennung hat keinen klaren Text erkannt.");
        }
      } catch (error) {
        console.warn("Android-Texterkennung fehlgeschlagen; nutze die Browser-Texterkennung.", error);
        setCameraStatus("Android-Erkennung ohne Treffer. Starte die alternative Texterkennung …");
        data = (await (await getOcrWorker()).recognize(canvas)).data;
      }
    } else {
      data = (await (await getOcrWorker()).recognize(canvas)).data;
    }
    recognizedLines = textLinesFromResult(data);
    renderRecognizedLines();

    if (recognizedLines.length === 0) {
      setCameraStatus(excludedOcrLineCount
        ? "Die erkannten Zeilen waren unsicher und werden nicht vorgelesen. Halte die Liste ruhig, näher und gut beleuchtet ins Bild und versuche es erneut."
        : "Kein Text erkannt. Richte die Kamera auf die Liste, verbessere das Licht und versuche es erneut.");
      return;
    }

    elements.readText.hidden = false;
    elements.readText.disabled = false;
    elements.searchCard.hidden = false;
    elements.listen.disabled = true;
    elements.result.hidden = true;
    const certaintyNote = excludedOcrLineCount
      ? ` ${excludedOcrLineCount} unsichere Zeilen wurden ausgeblendet.`
      : "";
    setCameraStatus(`${recognizedLines.length} sichere Textzeilen erkannt.${certaintyNote} Frage vorlesen lassen und den gesuchten Begriff nennen.`);
    elements.searchCard.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    setCameraStatus(error.message || "Die Texterkennung ist fehlgeschlagen. Bitte versuche es erneut.");
  } finally {
    elements.recognize.disabled = !cameraStream;
  }
}

function splitSpeechText(text, maxLength = 450) {
  const chunks = [];
  let remaining = text.trim();

  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf(" ", maxLength);
    if (splitAt <= 0) splitAt = maxLength;
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

async function readRecognizedText() {
  const selectedLines = getReadingMode() === "all"
    ? [...recognizedLines]
    : [...elements.recognizedLines.querySelectorAll(".line-selection-checkbox:checked")]
      .map((checkbox) => recognizedLines[Number(checkbox.dataset.lineIndex)])
      .filter(Boolean);
  if (selectedLines.length === 0) {
    setCameraStatus("Wähle mindestens eine erkannte Zeile zum Vorlesen aus.");
    return;
  }

  const text = selectedLines.map((line) => line.text).join(". ");
  const chunks = splitSpeechText(text);
  isReadingText = true;
  updateTextSelection();

  try {
    for (const [index, chunk] of chunks.entries()) {
      setCameraStatus(chunks.length === 1
        ? "Der erkannte Text wird vorgelesen …"
        : `Text wird vorgelesen (${index + 1} von ${chunks.length}) …`);
      if (!await speak(chunk)) {
        setCameraStatus("Vorlesen ist auf diesem Gerät nicht verfügbar. Prüfe die Sprachausgabe-Einstellungen.");
        return;
      }
    }

    setCameraStatus("Der erkannte Text wurde vollständig vorgelesen.");
  } finally {
    isReadingText = false;
    updateTextSelection();
  }
}

function normalizeText(text) {
  return text.toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function queryTerms(query) {
  return normalizeText(query).split(/\s+/).filter((term) => term.length > 1 && !searchStopWords.has(term));
}

function termMatches(queryTerm, lineTerm) {
  return queryTerm === lineTerm
    || (queryTerm.length >= 5 && lineTerm.startsWith(queryTerm))
    || (lineTerm.length >= 5 && queryTerm.startsWith(lineTerm));
}

function findBestMatch(query) {
  const normalizedQuery = normalizeText(query);
  const terms = queryTerms(query);
  if (!normalizedQuery || terms.length === 0) return [];

  const matches = recognizedLines.map((line, index) => {
    const normalizedLine = normalizeText(line.text);
    const lineTerms = normalizedLine.split(/\s+/);
    const matchedTerms = terms.filter((term) => lineTerms.some((lineTerm) => termMatches(term, lineTerm)));
    const score = normalizedLine.includes(normalizedQuery) ? 1 : matchedTerms.length / terms.length;
    return { index, score, matched: matchedTerms.length > 0 };
  }).filter((candidate) => candidate.matched && candidate.score >= 0.5);

  return matches.sort((first, second) => second.score - first.score || first.index - second.index);
}

function announceSearchResult(query) {
  const matches = findBestMatch(query);
  elements.result.hidden = false;
  elements.result.classList.toggle("no-match", matches.length === 0);

  if (matches.length === 0) {
    clearMatchHighlight();
    const message = `„${query}“ wurde in den ${recognizedLines.length} erkannten Zeilen nicht gefunden. Richte die Kamera neu aus oder versuche einen kürzeren Suchbegriff.`;
    elements.result.textContent = message;
    speak(`Ich habe ${query} nicht gefunden. Richte die Kamera neu aus oder versuche einen kürzeren Suchbegriff.`);
    return;
  }

  const best = matches[0];
  const position = best.index + 1;
  const line = recognizedLines[best.index];
  const message = matches.length > 1 && matches[1].score === best.score
    ? `„${line.text}“ passt am besten. Der erste passende Eintrag steht an Position ${position} von ${recognizedLines.length}, von oben. Es gibt weitere mögliche Treffer.`
    : `„${line.text}“ steht an Position ${position} von ${recognizedLines.length}, von oben.`;
  elements.result.textContent = message;
  highlightLine(best.index);
  speak(message);
}

function askWhatToFind() {
  setSpeechStatus("Was suchst du? Tippe auf „Sprechen“ und nenne den Begriff, oder gib ihn unten ein.");
  const prompt = speak("Was suchst du? Tippe auf Sprechen und nenne den Begriff, oder gib ihn ein.");
  if (!SpeechRecognition) {
    elements.query.focus();
    setSpeechStatus("Spracheingabe ist in diesem Browser nicht verfügbar. Du kannst den Suchbegriff unten eintippen.");
  } else {
    elements.listen.disabled = true;
    prompt.then(() => {
      elements.listen.disabled = false;
      setSpeechStatus("Frage gestellt. Tippe auf „Sprechen“ und nenne den Begriff.");
    });
  }
}

function startListening() {
  if (window.AndroidSpeechBridge) {
    elements.listen.disabled = true;
    setSpeechStatus("Öffne die Spracheingabe. Sage jetzt den gesuchten Begriff.");
    const requestId = `voice-${Date.now()}`;
    window.__nativeVoiceRequestId = requestId;
    window.AndroidSpeechBridge.startListening(requestId);
    return;
  }

  if (!SpeechRecognition) {
    setSpeechStatus("Spracheingabe ist in diesem Browser nicht verfügbar. Tippe den Suchbegriff in das Feld ein.");
    elements.query.focus();
    return;
  }

  activeRecognition?.abort();
  const recognition = new SpeechRecognition();
  activeRecognition = recognition;
  recognition.lang = "de-DE";
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
  elements.listen.disabled = true;
  setSpeechStatus("Ich höre zu. Sage jetzt den gesuchten Begriff.");

  recognition.onresult = (event) => {
    const transcript = event.results[0][0].transcript.trim();
    elements.query.value = transcript;
    setSpeechStatus(`Verstanden: „${transcript}“`);
    announceSearchResult(transcript);
  };
  recognition.onerror = (event) => {
    const messages = {
      "not-allowed": "Kein Mikrofonzugriff. Erlaube die Spracheingabe in den Browser-Einstellungen oder tippe den Begriff ein.",
      "no-speech": "Ich habe nichts gehört. Tippe auf „Sprechen“ und versuche es noch einmal.",
      "network": "Spracheingabe ist gerade nicht verfügbar. Tippe den Suchbegriff ein.",
    };
    setSpeechStatus(messages[event.error] ?? "Spracheingabe nicht möglich. Tippe den Suchbegriff ein.");
  };
  recognition.onend = () => {
    elements.listen.disabled = false;
    activeRecognition = undefined;
  };

  try {
    recognition.start();
  } catch {
    elements.listen.disabled = false;
    activeRecognition = undefined;
    setSpeechStatus("Das Mikrofon konnte nicht gestartet werden. Prüfe die Browser-Berechtigung oder tippe den Begriff ein.");
  }
}

elements.cameraStart.addEventListener("click", startCamera);
elements.cameraStop.addEventListener("click", stopCamera);
elements.recognize.addEventListener("click", recognizeText);
elements.readText.addEventListener("click", readRecognizedText);
elements.ask.addEventListener("click", askWhatToFind);
elements.listen.addEventListener("click", startListening);
elements.selectAllLines.addEventListener("change", () => {
  for (const checkbox of elements.recognizedLines.querySelectorAll(".line-selection-checkbox")) {
    checkbox.checked = elements.selectAllLines.checked;
  }
  updateTextSelection();
});
elements.readingMode.addEventListener("change", updateTextSelection);
elements.recognizedLines.addEventListener("change", (event) => {
  if (event.target.matches(".line-selection-checkbox")) updateTextSelection();
});
elements.searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const query = elements.query.value.trim();
  if (query) announceSearchResult(query);
});
elements.zoom.addEventListener("input", () => {
  const zoom = Number(elements.zoom.value);
  elements.viewfinder.style.setProperty("--zoom", String(zoom));
  elements.zoomValue.value = `${zoom.toFixed(1).replace(".", ",")}×`;
  clearMatchHighlight();
  if (cameraStream && !elements.capturedImage.hidden) {
    elements.camera.hidden = false;
    elements.capturedImage.hidden = true;
    elements.imageOverlays.hidden = true;
    elements.searchCard.hidden = true;
    elements.result.hidden = true;
    setCameraStatus("Ausschnitt geändert. Tippe auf „Text erkennen“, um die neue Ansicht zu durchsuchen.");
  }
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js").catch((error) => {
      console.warn("Offline-Speicherung konnte nicht aktiviert werden.", error);
    });
  });
}

window.__onNativePermissionResult = (requestId, granted) => {
  const callback = window.__nativePermissionCallbacks?.[requestId];
  if (!callback) return;
  delete window.__nativePermissionCallbacks[requestId];
  callback(granted);
};

window.__onNativeSpeechComplete = (requestId, success) => {
  const callback = window.__nativeSpeechCallbacks?.[requestId];
  if (!callback) return;
  delete window.__nativeSpeechCallbacks[requestId];
  callback(success);
};

window.__onNativeVoiceResult = (requestId, transcript, errorMessage) => {
  if (requestId !== window.__nativeVoiceRequestId) return;
  window.__nativeVoiceRequestId = undefined;
  elements.listen.disabled = false;
  if (transcript) {
    elements.query.value = transcript;
    setSpeechStatus(`Verstanden: „${transcript}“`);
    announceSearchResult(transcript);
    return;
  }
  setSpeechStatus(errorMessage || "Spracheingabe nicht möglich. Tippe den Suchbegriff ein.");
};

window.__onNativeOcrResult = (requestId, payload, errorMessage) => {
  const callback = window.__nativeOcrCallbacks?.[requestId];
  if (!callback) return;
  delete window.__nativeOcrCallbacks[requestId];

  if (errorMessage) {
    callback.reject(new Error(errorMessage));
    return;
  }

  try {
    callback.resolve(JSON.parse(payload));
  } catch (error) {
    callback.reject(new Error(`Android-Texterkennung lieferte ein ungültiges Ergebnis: ${error.message}`));
  }
};
