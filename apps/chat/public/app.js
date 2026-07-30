(() => {
  "use strict";

  const DEFAULT_CONFIG = {
    name: "Project Manager",
    subtitle:
      "Turn meetings, documents, and project ideas into clear next actions.",
    welcomeMessage:
      "Hello! I’m your Project Manager. Add a meeting transcript or tell me what you’re working on, and I’ll help turn it into decisions, plans, and safe next actions.",
    primaryColour: "#6D4AFF",
    examplePrompts: [
      "Turn these meeting notes into decisions and action items",
      "Build a practical project plan from this document",
      "Show me the highest-priority work in my local project",
    ],
  };
  const DEFAULT_AGENTS = [
    {
      id: "project-manager",
      name: "Project Manager",
      description:
        "Plans projects, analyses meetings, and turns decisions into safe next actions.",
      status: "active",
      examplePrompts: DEFAULT_CONFIG.examplePrompts,
    },
    {
      id: "sales",
      name: "Sales",
      description: "Sales research, preparation, and follow-up workflows.",
      status: "coming-soon",
      examplePrompts: [],
    },
    {
      id: "marketing",
      name: "Marketing",
      description: "Campaign planning, content, and marketing operations.",
      status: "coming-soon",
      examplePrompts: [],
    },
    {
      id: "investment",
      name: "Investment",
      description: "Investment research, analysis, and decision preparation.",
      status: "coming-soon",
      examplePrompts: [],
    },
    {
      id: "bookkeeping",
      name: "Bookkeeping",
      description: "Bookkeeping preparation, review, and reconciliation support.",
      status: "coming-soon",
      examplePrompts: [],
    },
  ];
  const STORAGE_KEY = "ai-solopreneur-chat-session";
  const MAX_DOCUMENTS = 3;
  const LARGE_PASTE_THRESHOLD = 4_000;

  const elements = {
    agentInitials: document.querySelector("#agent-initials"),
    agentList: document.querySelector("#agent-list"),
    agentName: document.querySelector("#agent-name"),
    agentSubtitle: document.querySelector("#agent-subtitle"),
    attachmentMenu: document.querySelector("#attachment-menu"),
    attachmentMenuButton: document.querySelector("#attachment-menu-button"),
    characterCount: document.querySelector("#character-count"),
    conversation: document.querySelector("#conversation"),
    conversationAgentName: document.querySelector("#conversation-agent-name"),
    documentList: document.querySelector("#document-list"),
    documentStatus: document.querySelector("#document-status"),
    fileInput: document.querySelector("#file-input"),
    form: document.querySelector("#chat-form"),
    input: document.querySelector("#message-input"),
    mobileAgentInitials: document.querySelector("#mobile-agent-initials"),
    pasteButton: document.querySelector("#paste-button"),
    pasteCancel: document.querySelector("#paste-cancel"),
    pasteDialog: document.querySelector("#paste-dialog"),
    pastedName: document.querySelector("#pasted-name"),
    pastedText: document.querySelector("#pasted-text"),
    pasteForm: document.querySelector("#paste-form"),
    requestStatus: document.querySelector("#request-status"),
    resetButton: document.querySelector("#reset-button"),
    sendButton: document.querySelector("#send-button"),
    sendButtonLabel: document.querySelector("#send-button-label"),
    suggestionList: document.querySelector("#suggestion-list"),
    suggestions: document.querySelector("#suggestions"),
    uploadButton: document.querySelector("#upload-button"),
  };

  let sessionId = loadOrCreateSession();
  let requestInProgress = false;
  let documentRequestInProgress = false;
  let loadingMessage = null;
  let agents = DEFAULT_AGENTS;
  let activeAgentId = "project-manager";
  let uploadedDocuments = [];
  let sessionDocuments = [];

  function cleanText(value, fallback, maximumLength) {
    if (typeof value !== "string") {
      return fallback;
    }
    const cleaned = value.trim();
    return cleaned.length > 0 ? cleaned.slice(0, maximumLength) : fallback;
  }

  function loadConfig() {
    const supplied =
      typeof window.AGENT_CONFIG === "object" && window.AGENT_CONFIG !== null
        ? window.AGENT_CONFIG
        : {};
    const prompts = Array.isArray(supplied.examplePrompts)
      ? supplied.examplePrompts
          .filter((prompt) => typeof prompt === "string" && prompt.trim())
          .slice(0, 6)
          .map((prompt) => prompt.trim().slice(0, 180))
      : DEFAULT_CONFIG.examplePrompts;
    const suppliedColour = cleanText(
      supplied.primaryColour,
      DEFAULT_CONFIG.primaryColour,
      40,
    );

    return {
      name: cleanText(supplied.name, DEFAULT_CONFIG.name, 60),
      subtitle: cleanText(
        supplied.subtitle,
        DEFAULT_CONFIG.subtitle,
        160,
      ),
      welcomeMessage: cleanText(
        supplied.welcomeMessage,
        DEFAULT_CONFIG.welcomeMessage,
        800,
      ),
      primaryColour:
        window.CSS?.supports("color", suppliedColour)
          ? suppliedColour
          : DEFAULT_CONFIG.primaryColour,
      examplePrompts:
        prompts.length > 0 ? prompts : DEFAULT_CONFIG.examplePrompts,
    };
  }

  const config = loadConfig();

  function activeAgent() {
    return (
      agents.find(
        (agent) => agent.id === activeAgentId && agent.status === "active",
      ) ?? agents.find((agent) => agent.status === "active")
    );
  }

  function displayAgentName() {
    return activeAgentId === "project-manager"
      ? config.name
      : activeAgent()?.name ?? config.name;
  }

  function getInitials(name) {
    return name
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part.charAt(0))
      .join("")
      .toUpperCase();
  }

  function createSessionId() {
    return window.crypto.randomUUID();
  }

  function storeSession(value) {
    try {
      window.localStorage.setItem(STORAGE_KEY, value);
    } catch {
      // The chat still works when private browsing blocks local storage.
    }
  }

  function loadOrCreateSession() {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (
        stored &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          stored,
        )
      ) {
        return stored;
      }
    } catch {
      // Fall through to a fresh session.
    }

    const freshSession = createSessionId();
    storeSession(freshSession);
    return freshSession;
  }

  function applyAgentIdentity() {
    const name = displayAgentName();
    const description =
      activeAgentId === "project-manager"
        ? config.subtitle
        : activeAgent()?.description ?? config.subtitle;
    document.title = `${name} · Local agent`;
    document.documentElement.style.setProperty(
      "--brand-primary",
      config.primaryColour,
    );
    elements.agentName.textContent = name;
    elements.agentSubtitle.textContent = description;
    elements.conversationAgentName.textContent = name;
    elements.input.setAttribute("aria-label", `Message ${name}`);
    elements.input.placeholder = `What should the ${name} do?`;

    const initials = getInitials(name);
    elements.agentInitials.textContent = initials;
    elements.mobileAgentInitials.textContent = initials;
  }

  function scrollConversation() {
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    elements.conversation.scrollTo({
      top: elements.conversation.scrollHeight,
      behavior: reduceMotion ? "auto" : "smooth",
    });
  }

  function createAvatar(kind) {
    const avatar = document.createElement("span");
    avatar.className = `message__avatar message__avatar--${kind}`;
    avatar.setAttribute("aria-hidden", "true");
    avatar.textContent =
      kind === "agent" ? getInitials(displayAgentName()) : "You";
    return avatar;
  }

  function documentMetadata(documentItem) {
    const pageText =
      typeof documentItem.pageCount === "number"
        ? ` · ${documentItem.pageCount} pages`
        : "";
    return `${documentItem.wordCount.toLocaleString()} words${pageText}`;
  }

  function documentTypeLabel(documentItem) {
    if (documentItem.type === "pasted-text") {
      return "TEXT";
    }
    return String(documentItem.type || "FILE").toUpperCase().slice(0, 5);
  }

  function createSentAttachment(documentItem) {
    const attachment = document.createElement("div");
    attachment.className = "sent-attachment";
    attachment.setAttribute(
      "aria-label",
      `Attached ${documentItem.name}, ${documentMetadata(documentItem)}`,
    );

    const preview = document.createElement("span");
    preview.className = `sent-attachment__preview sent-attachment__preview--${documentItem.type}`;
    preview.setAttribute("aria-hidden", "true");

    const pageFold = document.createElement("span");
    pageFold.className = "sent-attachment__fold";

    const previewLines = document.createElement("span");
    previewLines.className = "sent-attachment__lines";
    for (let index = 0; index < 3; index += 1) {
      previewLines.append(document.createElement("span"));
    }

    const type = document.createElement("span");
    type.className = "sent-attachment__type";
    type.textContent = documentTypeLabel(documentItem);
    preview.append(pageFold, previewLines, type);

    const details = document.createElement("span");
    details.className = "sent-attachment__details";

    const name = document.createElement("span");
    name.className = "sent-attachment__name";
    name.textContent = documentItem.name;
    name.title = documentItem.name;

    const metadata = document.createElement("span");
    metadata.className = "sent-attachment__meta";
    metadata.textContent = documentMetadata(documentItem);

    details.append(name, metadata);
    attachment.append(preview, details);
    return attachment;
  }

  function addMessage(kind, text, attachments = []) {
    const wrapper = document.createElement("article");
    wrapper.className = `message message--${kind}`;

    const body = document.createElement("div");
    body.className = "message__body";

    const label = document.createElement("p");
    label.className = "message__label";
    label.textContent = kind === "agent" ? displayAgentName() : "You";

    const copy = document.createElement("p");
    copy.className = "message__copy";
    copy.textContent = text;

    body.append(label);
    if (kind === "user" && attachments.length > 0) {
      const attachmentList = document.createElement("div");
      attachmentList.className = "message__attachments";
      attachmentList.setAttribute("aria-label", "Sent attachments");
      for (const documentItem of attachments) {
        attachmentList.append(createSentAttachment(documentItem));
      }
      body.append(attachmentList);
    }
    body.append(copy);
    wrapper.append(createAvatar(kind), body);
    elements.conversation.append(wrapper);
    scrollConversation();
    return wrapper;
  }

  function addLoadingMessage() {
    const wrapper = document.createElement("article");
    wrapper.className = "message message--agent";

    const body = document.createElement("div");
    body.className = "message__body";

    const label = document.createElement("p");
    label.className = "message__label";
    label.textContent = displayAgentName();

    const dots = document.createElement("span");
    dots.className = "thinking-dots";
    dots.setAttribute("aria-hidden", "true");
    for (let index = 0; index < 3; index += 1) {
      dots.append(document.createElement("span"));
    }

    const accessibleText = document.createElement("span");
    accessibleText.className = "visually-hidden";
    accessibleText.textContent = `${displayAgentName()} is thinking`;

    body.append(label, dots, accessibleText);
    wrapper.append(createAvatar("agent"), body);
    elements.conversation.append(wrapper);
    scrollConversation();
    return wrapper;
  }

  function addError(message, retryRequest) {
    const alert = document.createElement("div");
    alert.className = "chat-error";
    alert.setAttribute("role", "alert");

    const icon = document.createElement("span");
    icon.className = "chat-error__icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "!";

    const content = document.createElement("div");
    const title = document.createElement("p");
    title.className = "chat-error__title";
    title.textContent = "That didn’t work";
    const detail = document.createElement("p");
    detail.className = "chat-error__detail";
    detail.textContent = message;
    content.append(title, detail);

    if (retryRequest) {
      const retry = document.createElement("button");
      retry.className = "retry-button";
      retry.type = "button";
      retry.textContent = "Try again";
      retry.addEventListener("click", () => {
        alert.remove();
        void sendMessage(retryRequest.message, false, retryRequest.documents);
      });
      content.append(retry);
    }

    alert.append(icon, content);
    elements.conversation.append(alert);
    scrollConversation();
  }

  function friendlyError(errorBody, fallback) {
    if (
      typeof errorBody === "object" &&
      errorBody !== null &&
      typeof errorBody.error === "object" &&
      errorBody.error !== null &&
      typeof errorBody.error.message === "string"
    ) {
      return errorBody.error.message;
    }
    return fallback;
  }

  async function parseResponse(response, fallback) {
    let body = null;
    try {
      body = await response.json();
    } catch {
      // Use the stable fallback below.
    }
    if (!response.ok) {
      throw new Error(friendlyError(body, fallback));
    }
    return body;
  }

  async function loadAgents() {
    try {
      const response = await fetch("/api/agents", {
        headers: { Accept: "application/json" },
      });
      const body = await parseResponse(
        response,
        "The local agent list could not be loaded.",
      );
      if (
        body &&
        Array.isArray(body.agents) &&
        body.agents.some((agent) => agent?.status === "active")
      ) {
        agents = body.agents;
        activeAgentId =
          agents.find((agent) => agent.id === activeAgentId)?.status === "active"
            ? activeAgentId
            : agents.find((agent) => agent.status === "active").id;
      }
    } catch {
      agents = DEFAULT_AGENTS;
    }
  }

  function renderAgentList() {
    elements.agentList.replaceChildren();
    for (const agent of agents) {
      const button = document.createElement("button");
      button.className = "agent-button";
      button.type = "button";
      button.disabled =
        agent.status !== "active" ||
        requestInProgress ||
        documentRequestInProgress;
      button.setAttribute("role", "listitem");
      button.setAttribute(
        "aria-pressed",
        String(agent.id === activeAgentId),
      );

      const name = document.createElement("span");
      name.className = "agent-button__name";
      name.textContent = agent.name;

      const status = document.createElement("span");
      status.className = "agent-button__status";
      status.textContent =
        agent.status === "active"
          ? agent.id === activeAgentId
            ? "Active"
            : "Available"
          : "Coming soon";

      const description = document.createElement("span");
      description.className = "agent-button__description";
      description.textContent = agent.description;

      button.append(name, status, description);
      if (agent.status === "active") {
        button.addEventListener("click", () => {
          if (agent.id === activeAgentId) {
            return;
          }
          activeAgentId = agent.id;
          startNewConversation();
          applyAgentIdentity();
          renderAgentList();
          renderSuggestions();
        });
      }
      elements.agentList.append(button);
    }
  }

  function renderSuggestions() {
    elements.suggestionList.replaceChildren();
    const selectedPrompts =
      activeAgent()?.examplePrompts?.length > 0
        ? activeAgent().examplePrompts
        : config.examplePrompts;
    for (const prompt of selectedPrompts.slice(0, 6)) {
      const button = document.createElement("button");
      button.className = "suggestion-button";
      button.type = "button";
      button.textContent = prompt;
      button.addEventListener("click", () => {
        void sendMessage(prompt, true);
      });
      elements.suggestionList.append(button);
    }
  }

  function renderDocuments() {
    elements.documentList.replaceChildren();
    for (const documentItem of uploadedDocuments) {
      const chip = document.createElement("div");
      chip.className = "document-chip";

      const name = document.createElement("span");
      name.className = "document-chip__name";
      name.textContent = documentItem.name;
      name.title = documentItem.name;

      const metadata = document.createElement("span");
      metadata.className = "document-chip__meta";
      metadata.textContent = documentMetadata(documentItem);

      const remove = document.createElement("button");
      remove.className = "document-chip__remove";
      remove.type = "button";
      remove.textContent = "×";
      remove.setAttribute("aria-label", `Remove ${documentItem.name}`);
      remove.disabled = requestInProgress || documentRequestInProgress;
      remove.addEventListener("click", () => {
        void removeDocument(documentItem.id);
      });

      chip.append(name, metadata, remove);
      elements.documentList.append(chip);
    }
  }

  function renderNewConversation() {
    elements.conversation.replaceChildren();
    addMessage("agent", config.welcomeMessage);
    elements.suggestions.hidden = false;
    elements.input.value = "";
    updateCharacterCount();
    resizeInput();
  }

  function setBusy(isBusy) {
    requestInProgress = isBusy;
    const controlsBusy = isBusy || documentRequestInProgress;
    if (controlsBusy) {
      setAttachmentMenuOpen(false);
    }
    elements.conversation.setAttribute("aria-busy", String(isBusy));
    elements.input.disabled = controlsBusy;
    elements.sendButton.disabled = controlsBusy;
    elements.resetButton.disabled = controlsBusy;
    elements.attachmentMenuButton.disabled = controlsBusy;
    elements.uploadButton.disabled = controlsBusy;
    elements.pasteButton.disabled = controlsBusy;
    for (const suggestion of elements.suggestionList.querySelectorAll("button")) {
      suggestion.disabled = controlsBusy;
    }
    elements.sendButtonLabel.textContent = isBusy ? "Working" : "Send";
    elements.requestStatus.textContent = isBusy
      ? `${displayAgentName()} is working on your request…`
      : "Press Enter to send · Shift + Enter for a new line";
    renderAgentList();
    renderDocuments();
  }

  function setDocumentBusy(isBusy, message = "") {
    documentRequestInProgress = isBusy;
    elements.documentStatus.textContent = message;
    setBusy(requestInProgress);
  }

  function setAttachmentMenuOpen(isOpen) {
    elements.attachmentMenu.hidden = !isOpen;
    elements.attachmentMenuButton.setAttribute(
      "aria-expanded",
      String(isOpen),
    );
    if (isOpen) {
      elements.uploadButton.focus();
    }
  }

  async function uploadFile(file) {
    if (uploadedDocuments.length >= MAX_DOCUMENTS) {
      addError(`Add no more than ${MAX_DOCUMENTS} documents to one message.`);
      return;
    }

    setDocumentBusy(true, `Reading ${file.name}…`);
    try {
      const formData = new FormData();
      formData.append("sessionId", sessionId);
      formData.append("file", file);
      const response = await fetch("/api/documents", {
        method: "POST",
        body: formData,
      });
      const body = await parseResponse(
        response,
        "The document could not be read.",
      );
      if (!body?.document?.id) {
        throw new Error("The document reader returned an unexpected result.");
      }
      uploadedDocuments.push(body.document);
      sessionDocuments.push(body.document);
      renderDocuments();
      elements.documentStatus.textContent =
        body.document.warnings?.length > 0
          ? body.document.warnings[0]
          : "";
    } catch (error) {
      elements.documentStatus.textContent = "";
      addError(
        error instanceof Error
          ? error.message
          : "The document could not be read.",
      );
    } finally {
      documentRequestInProgress = false;
      setBusy(requestInProgress);
      elements.fileInput.value = "";
    }
  }

  async function uploadPastedText(name, text) {
    if (uploadedDocuments.length >= MAX_DOCUMENTS) {
      addError(`Add no more than ${MAX_DOCUMENTS} documents to one message.`);
      return false;
    }

    setDocumentBusy(true, "Preparing pasted text…");
    try {
      const response = await fetch("/api/documents/text", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, name, text }),
      });
      const body = await parseResponse(
        response,
        "The pasted text could not be prepared.",
      );
      if (!body?.document?.id) {
        throw new Error("The document reader returned an unexpected result.");
      }
      uploadedDocuments.push(body.document);
      sessionDocuments.push(body.document);
      renderDocuments();
      elements.documentStatus.textContent = "";
      return true;
    } catch (error) {
      elements.documentStatus.textContent = "";
      addError(
        error instanceof Error
          ? error.message
          : "The pasted text could not be prepared.",
      );
      return false;
    } finally {
      documentRequestInProgress = false;
      setBusy(requestInProgress);
    }
  }

  async function removeDocument(id) {
    const documentItem = uploadedDocuments.find((item) => item.id === id);
    if (!documentItem) {
      return;
    }

    setDocumentBusy(true, `Removing ${documentItem.name}…`);
    try {
      const response = await fetch(
        `/api/documents/${encodeURIComponent(id)}?sessionId=${encodeURIComponent(sessionId)}`,
        { method: "DELETE" },
      );
      if (!response.ok && response.status !== 404) {
        const body = await response.json().catch(() => null);
        throw new Error(
          friendlyError(body, "The document could not be removed."),
        );
      }
      uploadedDocuments = uploadedDocuments.filter((item) => item.id !== id);
      sessionDocuments = sessionDocuments.filter((item) => item.id !== id);
      elements.documentStatus.textContent = "";
    } catch (error) {
      addError(
        error instanceof Error
          ? error.message
          : "The document could not be removed.",
      );
    } finally {
      documentRequestInProgress = false;
      setBusy(requestInProgress);
    }
  }

  async function sendMessage(
    rawMessage,
    showUserMessage,
    retryDocuments,
  ) {
    if (requestInProgress || documentRequestInProgress) {
      return;
    }

    const message = rawMessage.trim();
    if (!message) {
      elements.input.focus();
      return;
    }

    const requestDocuments = Array.isArray(retryDocuments)
      ? retryDocuments
      : [...uploadedDocuments];

    if (showUserMessage) {
      addMessage("user", message, requestDocuments);
      uploadedDocuments = [];
      elements.fileInput.value = "";
      elements.pastedName.value = "";
      elements.pastedText.value = "";
      elements.documentStatus.textContent = "";
      renderDocuments();
    }
    elements.suggestions.hidden = true;
    elements.input.value = "";
    updateCharacterCount();
    resizeInput();
    setBusy(true);
    loadingMessage = addLoadingMessage();

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          agentId: activeAgentId,
          message,
          documentIds: requestDocuments.map((item) => item.id),
        }),
      });

      const responseBody = await parseResponse(
        response,
        "The local agent could not reply. Check that n8n is running, then try again.",
      );
      if (
        typeof responseBody !== "object" ||
        responseBody === null ||
        responseBody.sessionId !== sessionId ||
        typeof responseBody.reply !== "string" ||
        !responseBody.reply.trim()
      ) {
        throw new Error(
          "The agent returned an unexpected response. Check the workflow and try again.",
        );
      }

      loadingMessage.remove();
      loadingMessage = null;
      addMessage("agent", responseBody.reply.trim());
    } catch (error) {
      loadingMessage?.remove();
      loadingMessage = null;
      addError(
        error instanceof Error
          ? error.message
          : "The local agent could not reply. Check n8n and try again.",
        { message, documents: requestDocuments },
      );
    } finally {
      setBusy(false);
      elements.input.focus();
    }
  }

  function updateCharacterCount() {
    const length = elements.input.value.length;
    elements.characterCount.textContent = `${length} / 8000`;
    elements.characterCount.classList.toggle(
      "character-count--near-limit",
      length >= 7_200,
    );
  }

  function resizeInput() {
    elements.input.style.height = "auto";
    elements.input.style.height = `${Math.min(elements.input.scrollHeight, 160)}px`;
  }

  function startNewConversation() {
    const previousSessionId = sessionId;
    const previousDocuments = sessionDocuments;
    sessionId = createSessionId();
    storeSession(sessionId);
    uploadedDocuments = [];
    sessionDocuments = [];
    renderDocuments();
    elements.fileInput.value = "";
    elements.pastedName.value = "";
    elements.pastedText.value = "";
    elements.documentStatus.textContent = "";
    setAttachmentMenuOpen(false);
    renderNewConversation();
    elements.requestStatus.textContent = "New conversation started";
    elements.input.focus();

    for (const documentItem of previousDocuments) {
      void fetch(
        `/api/documents/${encodeURIComponent(documentItem.id)}?sessionId=${encodeURIComponent(previousSessionId)}`,
        { method: "DELETE" },
      );
    }
  }

  elements.form.addEventListener("submit", (event) => {
    event.preventDefault();
    void sendMessage(elements.input.value, true);
  });

  elements.input.addEventListener("input", () => {
    updateCharacterCount();
    resizeInput();
  });

  elements.input.addEventListener("paste", (event) => {
    const pastedText = event.clipboardData?.getData("text") ?? "";
    if (
      pastedText.length > LARGE_PASTE_THRESHOLD ||
      elements.input.value.length + pastedText.length > 8_000
    ) {
      event.preventDefault();
      void uploadPastedText("Pasted transcript", pastedText).then((added) => {
        if (added) {
          elements.documentStatus.textContent =
            "Large pasted text was added as document context. Add an instruction below.";
        }
      });
    }
  });

  elements.input.addEventListener("keydown", (event) => {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.isComposing
    ) {
      event.preventDefault();
      elements.form.requestSubmit();
    }
  });

  elements.attachmentMenuButton.addEventListener("click", () => {
    setAttachmentMenuOpen(elements.attachmentMenu.hidden);
  });

  elements.uploadButton.addEventListener("click", () => {
    setAttachmentMenuOpen(false);
    elements.fileInput.click();
  });

  elements.fileInput.addEventListener("change", () => {
    const file = elements.fileInput.files?.[0];
    if (file) {
      void uploadFile(file);
    }
  });

  elements.pasteButton.addEventListener("click", () => {
    setAttachmentMenuOpen(false);
    elements.pastedName.value = "Pasted transcript";
    elements.pastedText.value = "";
    elements.pasteDialog.showModal();
    elements.pastedText.focus();
  });

  elements.pasteCancel.addEventListener("click", () => {
    elements.pasteDialog.close();
  });

  document.addEventListener("click", (event) => {
    if (
      !elements.attachmentMenu.hidden &&
      !elements.attachmentMenu.contains(event.target) &&
      !elements.attachmentMenuButton.contains(event.target)
    ) {
      setAttachmentMenuOpen(false);
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !elements.attachmentMenu.hidden) {
      event.preventDefault();
      setAttachmentMenuOpen(false);
      elements.attachmentMenuButton.focus();
    }
  });

  elements.pasteForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const name = elements.pastedName.value;
    const text = elements.pastedText.value;
    void uploadPastedText(name, text).then((added) => {
      if (added) {
        elements.pasteDialog.close();
        elements.input.focus();
      }
    });
  });

  elements.resetButton.addEventListener("click", startNewConversation);

  async function initialise() {
    await loadAgents();
    applyAgentIdentity();
    renderAgentList();
    renderSuggestions();
    renderDocuments();
    renderNewConversation();
  }

  void initialise();
})();
