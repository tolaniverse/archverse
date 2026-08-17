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
import {
  ApiError,
  createProject,
  deleteProject,
  getSession,
  githubLoginUrl,
  listProjects,
  logout,
  requestPlan,
  updateProject,
  type CloudProject,
  type Session,
} from "./api";
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
const LOCAL_CANVAS_KEY = "archverse-canvas-v1";
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

type AuthState = {
  status: "loading" | "ready" | "error";
  session: Session;
};

type CloudStatus = "idle" | "saving" | "saved" | "error" | "read-only";

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
  const [authState, setAuthState] = useState<AuthState>({
    status: "loading",
    session: { user: null, activePro: false },
  });
  const [cloudProjects, setCloudProjects] = useState<CloudProject[]>([]);
  const [activeProject, setActiveProject] = useState<CloudProject | null>(null);
  const [cloudPanelOpen, setCloudPanelOpen] = useState(false);
  const [cloudStatus, setCloudStatus] = useState<CloudStatus>("idle");
  const [cloudError, setCloudError] = useState<string | null>(null);
  const [cloudActionBusy, setCloudActionBusy] = useState(false);
  const lastSavedCloudDocument = useRef<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);

  const cloudReadOnly = Boolean(
    activeProject?.visibility === "private" && !authState.session.activePro,
  );
  const storageBlocked = Boolean(storageError && !activeProject);

  useEffect(() => {
    if (!cloudPanelOpen) return;
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setCloudPanelOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [cloudPanelOpen]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const session = await getSession();
        if (cancelled) return;
        setAuthState({ status: "ready", session });
        if (session.user) {
          try {
            const projects = await listProjects();
            if (!cancelled) setCloudProjects(projects);
          } catch (error) {
            if (!cancelled) {
              setCloudError(
                error instanceof Error
                  ? error.message
                  : "Cloud projects could not be loaded.",
              );
            }
          }
        }
      } catch {
        if (!cancelled) {
          setAuthState({
            status: "error",
            session: { user: null, activePro: false },
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!activeProject && !storageError) {
      localStorage.setItem(DOCUMENT_KEY, JSON.stringify(document));
    }
  }, [activeProject, document, storageError]);

  useEffect(() => {
    if (!editor || storageBlocked) return;
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
  }, [editor, storageBlocked]);

  useEffect(() => {
    editor?.updateInstanceState({ isReadonly: cloudReadOnly });
  }, [cloudReadOnly, editor]);

  useEffect(() => {
    if (!activeProject) return;
    if (cloudReadOnly) {
      setCloudStatus("read-only");
      return;
    }
    const snapshot = JSON.stringify(document);
    if (snapshot === lastSavedCloudDocument.current) return;

    let cancelled = false;
    setCloudStatus("saving");
    const timer = window.setTimeout(() => {
      void updateProject(activeProject, document)
        .then((saved) => {
          if (cancelled) return;
          lastSavedCloudDocument.current = JSON.stringify(saved.document);
          setActiveProject(saved);
          setCloudProjects((projects) =>
            projects.map((project) =>
              project.id === saved.id ? saved : project,
            ),
          );
          setCloudStatus("saved");
          setCloudError(null);
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          if (error instanceof ApiError && error.status === 402) {
            setCloudStatus("read-only");
          } else {
            setCloudStatus("error");
          }
          if (error instanceof ApiError && error.status === 409) {
            void listProjects()
              .then(setCloudProjects)
              .catch(() => undefined);
          }
          setCloudError(
            error instanceof ApiError && error.status === 409
              ? "This project changed elsewhere. The cloud list was refreshed; reopen it before editing again."
              : error instanceof Error
                ? error.message
                : "The cloud project could not be saved.",
          );
        });
    }, 1_000);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activeProject, cloudReadOnly, document]);

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
    if (status === "error" || cloudStatus === "error") return "Action needed";
    if (!activeProject) return "Local autosave active";
    if (cloudStatus === "saving") return "Saving to cloud";
    if (cloudStatus === "read-only") return "Private project · read only";
    return "Cloud autosave active";
  }, [activeProject, busy, cloudStatus, status]);

  function currentDocument(): ArchitectureDocument {
    return editor ? readDocumentFromCanvas(editor, document) : document;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const request = prompt.trim();
    if (
      request.length < 3 ||
      busy ||
      !editor ||
      storageBlocked ||
      cloudReadOnly
    )
      return;

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

  function openCloudProject(project: CloudProject) {
    if (!activeProject && !storageError) {
      localStorage.setItem(DOCUMENT_KEY, JSON.stringify(currentDocument()));
    }
    lastSavedCloudDocument.current = JSON.stringify(project.document);
    setActiveProject(project);
    setDocument(project.document);
    setEditor(null);
    setCloudStatus(
      project.visibility === "private" && !authState.session.activePro
        ? "read-only"
        : "saved",
    );
    setCloudError(null);
    setCloudPanelOpen(false);
  }

  function openLocalDraft() {
    const loaded = loadDocument();
    lastSavedCloudDocument.current = null;
    setActiveProject(null);
    setDocument(loaded.document);
    setStorageError(loaded.recoveryError);
    setEditor(null);
    setCloudStatus("idle");
    setCloudError(null);
    setCloudPanelOpen(false);
  }

  async function createCloudProject(visibility: CloudProject["visibility"]) {
    if (!authState.session.user || cloudActionBusy) return;
    const current = currentDocument();
    setDocument(current);
    setCloudActionBusy(true);
    setCloudError(null);
    try {
      const created = await createProject({
        title: current.title,
        visibility,
        document: current,
      });
      setCloudProjects((projects) => [
        created,
        ...projects.filter((project) => project.id !== created.id),
      ]);
      openCloudProject(created);
    } catch (error) {
      setCloudError(
        error instanceof Error
          ? error.message
          : "The cloud project could not be created.",
      );
    } finally {
      setCloudActionBusy(false);
    }
  }

  async function removeCloudProject(project: CloudProject) {
    if (
      cloudActionBusy ||
      !window.confirm(`Delete “${project.title}” from the cloud?`)
    ) {
      return;
    }
    setCloudActionBusy(true);
    setCloudError(null);
    try {
      await deleteProject(project);
      setCloudProjects((projects) =>
        projects.filter((candidate) => candidate.id !== project.id),
      );
      if (activeProject?.id === project.id) openLocalDraft();
    } catch (error) {
      setCloudError(
        error instanceof Error
          ? error.message
          : "The cloud project could not be deleted.",
      );
    } finally {
      setCloudActionBusy(false);
    }
  }

  async function signOut() {
    if (cloudActionBusy || cloudStatus === "saving") return;
    setCloudActionBusy(true);
    setCloudError(null);
    try {
      await logout();
      if (activeProject) openLocalDraft();
      setCloudProjects([]);
      setAuthState({
        status: "ready",
        session: { user: null, activePro: false },
      });
    } catch (error) {
      setCloudError(
        error instanceof Error ? error.message : "Sign out failed.",
      );
    } finally {
      setCloudActionBusy(false);
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
          <span>{activeProject ? activeProject.title : "Local draft"}</span>
          <span>{componentCount} components</span>
          <span>{connectionCount} connections</span>
        </div>

        <div className="topbar-actions" aria-label="Project and export actions">
          <button
            className="button button--cloud"
            type="button"
            onClick={() => setCloudPanelOpen(true)}
            aria-haspopup="dialog"
          >
            <span className="cloud-indicator" data-state={cloudStatus} />
            {authState.session.user
              ? `@${authState.session.user.githubLogin}`
              : "Cloud"}
          </button>
          <button
            className="button button--quiet"
            type="button"
            onClick={exportJson}
            disabled={!canExport}
          >
            <span className="export-prefix">Export </span>JSON
          </button>
          <button
            className="button button--quiet"
            type="button"
            onClick={exportMarkdown}
            disabled={!canExport}
          >
            <span className="export-prefix">Export </span>Markdown
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
              key={activeProject?.id ?? "local"}
              persistenceKey={
                activeProject
                  ? `archverse-cloud-canvas-${activeProject.id}`
                  : LOCAL_CANVAS_KEY
              }
              {...(tldrawLicenseKey ? { licenseKey: tldrawLicenseKey } : {})}
              onMount={(mountedEditor) => {
                setEditor(mountedEditor);
                if (!storageBlocked) {
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
            {activeProject && cloudReadOnly ? (
              <article className="message" data-role="notice">
                <span>Private project</span>
                <p>
                  Your Pro subscription is inactive. This project remains
                  available to export or delete, but editing is read-only.
                </p>
              </article>
            ) : null}
            {activeProject && cloudError ? (
              <article className="message" data-role="error" role="alert">
                <span>Cloud sync</span>
                <p>{cloudError}</p>
              </article>
            ) : null}
            {storageBlocked ? (
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
              disabled={busy || storageBlocked || cloudReadOnly}
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
                  storageBlocked ||
                  cloudReadOnly
                }
              >
                {busy ? "Planning…" : "Update diagram"}
              </button>
            </div>
          </form>
        </aside>
      </section>

      {cloudPanelOpen ? (
        <div
          className="cloud-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setCloudPanelOpen(false);
          }}
        >
          <section
            className="cloud-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="cloud-dialog-title"
          >
            <header className="cloud-dialog__header">
              <div>
                <span className="technical-label">Workspace</span>
                <h2 id="cloud-dialog-title">Cloud projects</h2>
              </div>
              <button
                className="icon-button"
                type="button"
                onClick={() => setCloudPanelOpen(false)}
                aria-label="Close cloud projects"
                autoFocus
              >
                ×
              </button>
            </header>

            {authState.status === "loading" ? (
              <div className="cloud-empty" role="status">
                <p>Checking your session…</p>
              </div>
            ) : authState.session.user ? (
              <>
                <div className="account-row">
                  <div className="account-identity">
                    {authState.session.user.avatarUrl ? (
                      <img
                        src={authState.session.user.avatarUrl}
                        alt=""
                        width="36"
                        height="36"
                      />
                    ) : (
                      <span className="account-avatar" aria-hidden="true">
                        {authState.session.user.githubLogin
                          .slice(0, 1)
                          .toUpperCase()}
                      </span>
                    )}
                    <div>
                      <strong>@{authState.session.user.githubLogin}</strong>
                      <span>
                        {authState.session.activePro ? "Pro plan" : "Free plan"}
                      </span>
                    </div>
                  </div>
                  <button
                    className="button button--quiet button--compact"
                    type="button"
                    onClick={() => void signOut()}
                    disabled={cloudActionBusy || cloudStatus === "saving"}
                  >
                    Sign out
                  </button>
                </div>

                <div className="cloud-create">
                  <div>
                    <span className="technical-label">Save current draft</span>
                    <p>
                      Create a cloud copy of the architecture on your canvas.
                    </p>
                  </div>
                  <div className="cloud-create__actions">
                    <button
                      className="button button--quiet"
                      type="button"
                      onClick={() => void createCloudProject("public")}
                      disabled={cloudActionBusy}
                    >
                      Save public copy
                    </button>
                    <button
                      className="button button--primary"
                      type="button"
                      onClick={() => void createCloudProject("private")}
                      disabled={cloudActionBusy || !authState.session.activePro}
                      title={
                        authState.session.activePro
                          ? undefined
                          : "Private cloud projects require Pro"
                      }
                    >
                      Save private copy
                    </button>
                  </div>
                  {!authState.session.activePro ? (
                    <p className="pro-note">
                      Private cloud projects require Pro. Local private drafts
                      remain free.
                    </p>
                  ) : null}
                </div>

                {cloudError ? (
                  <p className="cloud-error" role="alert">
                    {cloudError}
                  </p>
                ) : null}

                <div className="project-list" aria-label="Your projects">
                  <div className="project-row" data-active={!activeProject}>
                    <button
                      type="button"
                      onClick={openLocalDraft}
                      disabled={cloudStatus === "saving"}
                    >
                      <span className="project-row__title">Local draft</span>
                      <span className="project-row__meta">
                        Private on this device · Free
                      </span>
                    </button>
                  </div>
                  {cloudProjects.map((project) => (
                    <div
                      className="project-row"
                      data-active={activeProject?.id === project.id}
                      key={project.id}
                    >
                      <button
                        type="button"
                        onClick={() => openCloudProject(project)}
                        disabled={cloudStatus === "saving"}
                      >
                        <span className="project-row__title">
                          {project.title}
                        </span>
                        <span className="project-row__meta">
                          {project.visibility} · revision {project.revision}
                        </span>
                      </button>
                      <button
                        className="project-delete"
                        type="button"
                        aria-label={`Delete ${project.title}`}
                        title="Delete cloud project"
                        onClick={() => void removeCloudProject(project)}
                        disabled={cloudActionBusy}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  {cloudProjects.length === 0 ? (
                    <p className="project-list__empty">
                      No cloud projects yet. Save this draft as your first one.
                    </p>
                  ) : null}
                </div>
              </>
            ) : (
              <div className="cloud-empty">
                <span className="cloud-empty__mark" aria-hidden="true">
                  ↗
                </span>
                <h3>Take your work across devices</h3>
                <p>
                  Sign in with GitHub to save public cloud projects. Your local
                  private draft stays on this device.
                </p>
                <button
                  className="button button--primary"
                  type="button"
                  onClick={() => window.location.assign(githubLoginUrl())}
                >
                  Continue with GitHub
                </button>
                {authState.status === "error" ? (
                  <p className="cloud-error" role="alert">
                    Cloud services are unavailable. Your local draft is safe.
                  </p>
                ) : null}
              </div>
            )}
          </section>
        </div>
      ) : null}
    </main>
  );
}
