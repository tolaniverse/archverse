import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { Tldraw, type Editor } from "@tldraw/tldraw";
import "@tldraw/tldraw/tldraw.css";
import {
  ArchitectureDocumentSchema,
  applyDiagramCommands,
  architectureToMarkdown,
  emptyArchitectureDocument,
  type ArchitectureDocument,
} from "@archverse/architecture-model";
import { requestPlan } from "./api";
import {
  readDocumentFromCanvas,
  reconcileCanvas,
  selectedDomainNodeIds,
} from "./canvas";
import { downloadText } from "./download";
import { titleFromPrompt } from "./text";
import "./styles.css";

const DOCUMENT_KEY = "archverse:architecture-document:v1";
const RECOVERY_KEY = "archverse:architecture-document:recovery";
const tldrawLicenseKey = import.meta.env.VITE_TLDRAW_LICENSE_KEY as
  string | undefined;

const examples = [
  "A user-facing API with Postgres and a Redis cache",
  "A webhook service with Kafka, workers, and WhatsApp notifications",
];

type ChatMessage = {
  id: string;
  role: "assistant" | "user" | "error";
  text: string;
  source?: "demo" | "openai";
};

type LoadedDocument = {
  document: ArchitectureDocument;
  recoveryError: string | null;
};

function loadDocument(): LoadedDocument {
  const saved = localStorage.getItem(DOCUMENT_KEY);
  if (!saved)
    return { document: emptyArchitectureDocument(), recoveryError: null };

  try {
    return {
      document: ArchitectureDocumentSchema.parse(JSON.parse(saved)),
      recoveryError: null,
    };
  } catch {
    try {
      localStorage.setItem(RECOVERY_KEY, saved);
    } catch {
      // Keep the original value untouched if browser storage is unavailable.
    }
    return {
      document: emptyArchitectureDocument(),
      recoveryError:
        "The saved architecture could not be read. Its original data was preserved for recovery.",
    };
  }
}

export function App() {
  const [initialLoad] = useState(loadDocument);
  const [document, setDocument] = useState<ArchitectureDocument>(
    initialLoad.document,
  );
  const [storageError, setStorageError] = useState<string | null>(
    initialLoad.recoveryError,
  );
  const [editor, setEditor] = useState<Editor | null>(null);
  const [prompt, setPrompt] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "welcome",
      role: "assistant",
      text: "Describe a system. I’ll turn it into editable components and connections.",
    },
  ]);
  const formRef = useRef<HTMLFormElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!storageError)
      localStorage.setItem(DOCUMENT_KEY, JSON.stringify(document));
  }, [document, storageError]);

  useEffect(() => {
    if (!editor || storageError) return;
    let saveTimer: number | undefined;
    const unsubscribe = editor.store.listen(
      () => {
        window.clearTimeout(saveTimer);
        saveTimer = window.setTimeout(() => {
          setDocument((current) => readDocumentFromCanvas(editor, current));
        }, 150);
      },
      { source: "user", scope: "document" },
    );

    return () => {
      window.clearTimeout(saveTimer);
      unsubscribe();
    };
  }, [editor, storageError]);

  const componentCount = document.nodes.length;
  const connectionCount = document.edges.length;
  const busy = status === "loading";
  const canExport = componentCount > 0;

  useEffect(() => {
    const region = messagesRef.current;
    if (region) region.scrollTop = region.scrollHeight;
  }, [messages, busy]);
  const statusText = useMemo(() => {
    if (busy) return "Planning changes";
    if (status === "error") return "Action needed";
    return "Local autosave active";
  }, [busy, status]);

  function currentDocument(): ArchitectureDocument {
    return editor ? readDocumentFromCanvas(editor, document) : document;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const request = prompt.trim();
    if (request.length < 3 || busy || !editor || storageError) return;

    const before = currentDocument();
    setDocument(before);
    setStatus("loading");
    setMessages((items) => [
      ...items,
      { id: crypto.randomUUID(), role: "user", text: request },
    ]);

    try {
      const plan = await requestPlan({
        prompt: request,
        document: before,
        selectedNodeIds: selectedDomainNodeIds(editor),
      });
      let next = applyDiagramCommands(before, plan.commands);
      if (before.nodes.length === 0)
        next = { ...next, title: titleFromPrompt(request) };
      reconcileCanvas(editor, before, next);
      editor.selectNone();
      if (next.nodes.length > before.nodes.length) editor.zoomToFit();
      setDocument(next);
      setPrompt("");
      setMessages((items) => [
        ...items,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          text: plan.summary,
          source: plan.source,
        },
      ]);
      setStatus("idle");
    } catch (error) {
      setStatus("error");
      setMessages((items) => [
        ...items,
        {
          id: crypto.randomUUID(),
          role: "error",
          text:
            error instanceof Error
              ? error.message
              : "The diagram could not be updated. Try again.",
        },
      ]);
    } finally {
      window.requestAnimationFrame(() => promptRef.current?.focus());
    }
  }

  function resetLocalProject() {
    localStorage.removeItem(DOCUMENT_KEY);
    localStorage.removeItem(RECOVERY_KEY);
    const empty = emptyArchitectureDocument();
    if (editor) reconcileCanvas(editor, currentDocument(), empty);
    setDocument(empty);
    setStorageError(null);
    setStatus("idle");
  }

  function handlePromptKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      formRef.current?.requestSubmit();
    }
  }

  function exportJson() {
    const current = currentDocument();
    setDocument(current);
    downloadText(
      "archverse-architecture.json",
      `${JSON.stringify(current, null, 2)}\n`,
      "application/json",
    );
  }

  function exportMarkdown() {
    const current = currentDocument();
    setDocument(current);
    downloadText(
      "archverse-architecture.md",
      architectureToMarkdown(current),
      "text/markdown",
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <span className="brand-mark" aria-hidden="true">
            A/
          </span>
          <div>
            <h1>Archverse</h1>
            <p>Architecture workbench</p>
          </div>
        </div>

        <div className="project-readout" aria-live="polite">
          <span>{componentCount} components</span>
          <span>{connectionCount} connections</span>
        </div>

        <div className="topbar-actions" aria-label="Export architecture">
          <button
            className="button button--quiet"
            type="button"
            onClick={exportJson}
            disabled={!canExport}
          >
            Export JSON
          </button>
          <button
            className="button button--quiet"
            type="button"
            onClick={exportMarkdown}
            disabled={!canExport}
          >
            Export Markdown
          </button>
        </div>
      </header>

      <section className="workspace" aria-label="Architecture workspace">
        <div className="canvas-panel">
          <div className="canvas-label">
            <span>Live canvas</span>
            <span className="canvas-status" data-state={status}>
              {statusText}
            </span>
          </div>
          <div className="canvas-stage">
            <Tldraw
              persistenceKey="archverse-canvas-v1"
              {...(tldrawLicenseKey ? { licenseKey: tldrawLicenseKey } : {})}
              onMount={(mountedEditor) => {
                setEditor(mountedEditor);
                if (!storageError) {
                  reconcileCanvas(
                    mountedEditor,
                    emptyArchitectureDocument(),
                    document,
                  );
                  mountedEditor.selectNone();
                  if (document.nodes.length > 0) mountedEditor.zoomToFit();
                }
              }}
            />
            {componentCount === 0 ? (
              <div className="canvas-empty" aria-hidden="true">
                <span>01</span>
                <p>Your first prompt will place editable shapes here.</p>
              </div>
            ) : null}
          </div>
        </div>

        <aside className="chat-panel" aria-label="AI diagram planner">
          <div className="chat-heading">
            <div>
              <span className="technical-label">Planner</span>
              <h2>Edit the system</h2>
            </div>
            <span className="mode-chip">AI + demo fallback</span>
          </div>

          <div className="messages" ref={messagesRef} aria-live="polite">
            {storageError ? (
              <article className="message" data-role="error" role="alert">
                <span>Recovery needed</span>
                <p>{storageError}</p>
                <button
                  className="button button--quiet"
                  type="button"
                  onClick={resetLocalProject}
                >
                  Reset local project
                </button>
              </article>
            ) : null}
            {messages.map((message) => (
              <article
                className="message"
                data-role={message.role}
                key={message.id}
              >
                <span>
                  {message.role === "user"
                    ? "You"
                    : message.role === "error"
                      ? "Error"
                      : "Archverse"}
                </span>
                <p>{message.text}</p>
                {message.source ? (
                  <small>
                    {message.source === "demo" ? "Demo planner" : "OpenAI"}
                  </small>
                ) : null}
              </article>
            ))}
            {busy ? (
              <div className="planning-progress" role="status">
                <span />
                <p>Validating diagram commands…</p>
              </div>
            ) : null}
          </div>

          {componentCount === 0 ? (
            <div className="examples" aria-label="Example prompts">
              <span>Try a starting point</span>
              {examples.map((example) => (
                <button
                  type="button"
                  key={example}
                  onClick={() => setPrompt(example)}
                >
                  {example}
                </button>
              ))}
            </div>
          ) : (
            <p className="selection-hint">
              Select a component, then ask to rename, remove, or connect it.
            </p>
          )}

          <form className="prompt-form" ref={formRef} onSubmit={handleSubmit}>
            <label htmlFor="diagram-prompt">
              Describe the next architecture change
            </label>
            <textarea
              id="diagram-prompt"
              ref={promptRef}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={handlePromptKeyDown}
              placeholder="Add a queue between the API and worker"
              rows={4}
              minLength={3}
              maxLength={4_000}
              disabled={busy || Boolean(storageError)}
              aria-describedby="prompt-help"
            />
            <div className="prompt-actions">
              <span id="prompt-help">⌘ Enter to run</span>
              <button
                className="button button--primary"
                type="submit"
                disabled={
                  busy ||
                  prompt.trim().length < 3 ||
                  !editor ||
                  Boolean(storageError)
                }
              >
                {busy ? "Planning…" : "Update diagram"}
              </button>
            </div>
          </form>
        </aside>
      </section>
    </main>
  );
}
