import {
  App,
  CachedMetadata,
  MarkdownView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TAbstractFile,
  TFile,
} from "obsidian";

interface TitleH1FilenameSyncSettings {
  disallowedChars: string;
  syncOnSave: boolean;
  syncFilename: boolean;
  syncTitle: boolean;
  showRenameNotice: boolean;
}

const DEFAULT_SETTINGS: TitleH1FilenameSyncSettings = {
  disallowedChars: '*"\\/<>:|?',
  syncOnSave: true,
  syncFilename: true,
  syncTitle: true,
  showRenameNotice: false,
};

interface FileTitleState {
  title: string;
  h1: string;
}

interface LiveTitleAndH1 {
  title: string;
  h1: string;
  fileCache: CachedMetadata | null;
}

// `app.commands` is an internal Obsidian API not covered by the public obsidian.d.ts typings.
interface CommandsInternal {
  executeCommand: (command: { id: string }, ...args: unknown[]) => unknown;
  executeCommandById: (id: string, ...args: unknown[]) => unknown;
}

interface AppWithCommands extends App {
  commands: CommandsInternal;
}

export default class TitleH1FilenameSyncPlugin extends Plugin {
  settings!: TitleH1FilenameSyncSettings;

  lastKnownState = new Map<string, FileTitleState>();
  syncingFiles = new Set<string>();
  debounceTimeouts = new Map<string, number>();
  currentActiveFilePath: string | null = null;

  private originalExecuteCommand?: CommandsInternal["executeCommand"];
  private originalExecuteCommandById?: CommandsInternal["executeCommandById"];

  async onload(): Promise<void> {
    console.log(`Loading Title H1 Filename Sync Plugin v${this.manifest.version}`);

    await this.loadSettings();

    // Register event for metadata cache changes
    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        if (file.extension === "md") {
          this.onMetadataChanged(file);
        }
      })
    );

    // Register event for active file changes
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        const activeFile = this.app.workspace.getActiveFile();

        // 1. Sync previously active file immediately if it has pending changes
        if (this.currentActiveFilePath && this.currentActiveFilePath !== activeFile?.path) {
          const prevFile = this.app.vault.getAbstractFileByPath(this.currentActiveFilePath);
          if (prevFile instanceof TFile && prevFile.extension === "md") {
            this.syncFileImmediately(prevFile);
          }
        }

        // 2. Track new active file
        if (activeFile && activeFile.extension === "md") {
          this.currentActiveFilePath = activeFile.path;
          this.initializeFileState(activeFile);
        } else {
          this.currentActiveFilePath = null;
        }
      })
    );

    // Register rename and delete events to update our state cache
    this.registerEvent(
      this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
        // Update lastKnownState map key
        if (this.lastKnownState.has(oldPath)) {
          const state = this.lastKnownState.get(oldPath) as FileTitleState;
          this.lastKnownState.delete(oldPath);
          this.lastKnownState.set(file.path, state);
        }

        // Update current active file path if it was renamed
        if (this.currentActiveFilePath === oldPath) {
          this.currentActiveFilePath = file.path;
        }

        // Update pending debounce timeout key
        if (this.debounceTimeouts.has(oldPath)) {
          const timeout = this.debounceTimeouts.get(oldPath) as number;
          this.debounceTimeouts.delete(oldPath);
          this.debounceTimeouts.set(file.path, timeout);
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("delete", (file: TAbstractFile) => {
        this.lastKnownState.delete(file.path);

        if (this.debounceTimeouts.has(file.path)) {
          window.clearTimeout(this.debounceTimeouts.get(file.path));
          this.debounceTimeouts.delete(file.path);
        }

        if (this.currentActiveFilePath === file.path) {
          this.currentActiveFilePath = null;
        }
      })
    );

    // Hook into Obsidian's save command execution (covers both execution paths)
    const appWithCommands = this.app as AppWithCommands;

    this.originalExecuteCommand = appWithCommands.commands.executeCommand;
    appWithCommands.commands.executeCommand = (cmd, ...args) => {
      if (cmd && cmd.id === "editor:save-file") {
        this.trySyncOnSave();
      }
      return this.originalExecuteCommand?.call(appWithCommands.commands, cmd, ...args);
    };

    this.originalExecuteCommandById = appWithCommands.commands.executeCommandById;
    appWithCommands.commands.executeCommandById = (id, ...args) => {
      if (id === "editor:save-file") {
        this.trySyncOnSave();
      }
      return this.originalExecuteCommandById?.call(appWithCommands.commands, id, ...args);
    };

    // Also listen for Ctrl+S / Cmd+S via DOM keydown event in capture phase as a direct fallback
    this.registerDomEvent(
      window,
      "keydown",
      (evt: KeyboardEvent) => {
        if ((evt.ctrlKey || evt.metaKey) && (evt.key.toLowerCase() === "s" || evt.code === "KeyS")) {
          this.trySyncOnSave();
        }
      },
      true
    );

    // Register hotkey-enabled command for Save & Sync (Mod+S)
    this.addCommand({
      id: "sync-filename-title-h1",
      name: "Sync filename, title, and H1 now",
      hotkeys: [{ modifiers: ["Mod"], key: "s" }],
      callback: () => {
        this.trySyncOnSave();
      },
    });

    // Initialize state for the currently active file when plugin loads
    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile && activeFile.extension === "md") {
      this.currentActiveFilePath = activeFile.path;
      this.initializeFileState(activeFile);
    }

    this.addSettingTab(new TitleH1FilenameSyncSettingTab(this.app, this));
  }

  onunload(): void {
    console.log("Unloading Title H1 Filename Sync Plugin");

    // Restore monkey patches
    const appWithCommands = this.app as AppWithCommands;
    if (this.originalExecuteCommand) {
      appWithCommands.commands.executeCommand = this.originalExecuteCommand;
    }
    if (this.originalExecuteCommandById) {
      appWithCommands.commands.executeCommandById = this.originalExecuteCommandById;
    }

    // Clear all timeouts
    for (const timeout of this.debounceTimeouts.values()) {
      window.clearTimeout(timeout);
    }

    this.lastKnownState = new Map();
    this.syncingFiles.clear();
    this.debounceTimeouts.clear();
  }

  private trySyncOnSave(): void {
    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile && activeFile.extension === "md" && this.settings?.syncOnSave) {
      this.syncFileImmediately(activeFile, true);
    }
  }

  initializeFileState(file: TFile): void {
    if (this.lastKnownState.has(file.path)) return;

    const fileCache = this.app.metadataCache.getFileCache(file);
    const currentTitle = fileCache?.frontmatter?.title || "";
    const currentH1 = fileCache?.headings?.find((h) => h.level === 1)?.heading || "";

    this.lastKnownState.set(file.path, { title: currentTitle, h1: currentH1 });
  }

  onMetadataChanged(file: TFile): void {
    if (this.syncingFiles.has(file.path)) return;

    // Clear existing debounce timeout for this file
    if (this.debounceTimeouts.has(file.path)) {
      window.clearTimeout(this.debounceTimeouts.get(file.path));
    }

    // Set new debounce timeout (1.5 seconds) to avoid renaming on every keystroke
    const timeout = window.setTimeout(() => {
      this.debounceTimeouts.delete(file.path);
      this.syncFile(file);
    }, 1500);

    this.debounceTimeouts.set(file.path, timeout);
  }

  async syncFileImmediately(file: TFile, force = false): Promise<void> {
    if (this.debounceTimeouts.has(file.path)) {
      window.clearTimeout(this.debounceTimeouts.get(file.path));
      this.debounceTimeouts.delete(file.path);
    }

    await this.syncFile(file, force);
  }

  async getLiveTitleAndH1(file: TFile): Promise<LiveTitleAndH1> {
    let content = "";

    // Check if the file is open in the active workspace leaf/view
    const activeLeaf = this.app.workspace.activeLeaf;
    if (activeLeaf?.view instanceof MarkdownView) {
      const mv = activeLeaf.view;
      if (mv.file && mv.file.path === file.path && mv.editor) {
        content = mv.editor.getValue();
      }
    }

    if (!content) {
      const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (activeView && activeView.file && activeView.file.path === file.path && activeView.editor) {
        content = activeView.editor.getValue();
      } else {
        try {
          content = await this.app.vault.read(file);
        } catch (e) {
          content = "";
        }
      }
    }

    let title = "";
    let h1 = "";

    if (content) {
      const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      let contentAfterFrontmatter = content;
      if (frontmatterMatch) {
        const yaml = frontmatterMatch[1];
        const titleMatch = yaml.match(/^title:\s*(?:"([^"]*)"|'([^']*)'|(.*))$/m);
        if (titleMatch) {
          title = (titleMatch[1] || titleMatch[2] || titleMatch[3] || "").trim();
        }
        contentAfterFrontmatter = content.slice(frontmatterMatch[0].length);
      }

      const lines = contentAfterFrontmatter.split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("# ")) {
          h1 = trimmed.substring(2).trim();
          break;
        }
      }
    }

    // Fallback to metadataCache if live extraction returned empty but cache has values
    const fileCache = this.app.metadataCache.getFileCache(file);
    if (!title && fileCache?.frontmatter?.title) {
      title = fileCache.frontmatter.title;
    }
    if (!h1) {
      const cacheH1 = fileCache?.headings?.find((h) => h.level === 1)?.heading;
      if (cacheH1) h1 = cacheH1;
    }

    return { title, h1, fileCache: fileCache ?? this.app.metadataCache.getFileCache(file) };
  }

  async syncFile(file: TFile, force = false): Promise<void> {
    if (this.syncingFiles.has(file.path)) return;

    const { title: currentTitle, h1: currentH1, fileCache } = await this.getLiveTitleAndH1(file);

    if (!this.lastKnownState.has(file.path)) {
      this.lastKnownState.set(file.path, { title: currentTitle, h1: currentH1 });
      if (!force) return;
    }

    const lastKnown = this.lastKnownState.get(file.path) || { title: currentTitle, h1: currentH1 };

    // Check changes depending on settings
    const titleChanged = this.settings.syncTitle && currentTitle !== lastKnown.title;
    const h1Changed = currentH1 !== lastKnown.h1;

    const targetTextSource = this.settings.syncTitle ? currentH1 || currentTitle : currentH1;
    const expectedName = this.sanitizeFilename(targetTextSource);
    const currentName = file.basename;
    const filenameOutOfSync = this.settings.syncFilename && Boolean(expectedName) && expectedName !== currentName;
    const contentTitlesOutOfSync =
      this.settings.syncTitle && Boolean(currentTitle) && Boolean(currentH1) && currentTitle !== currentH1;

    if (!titleChanged && !h1Changed && !(force && (filenameOutOfSync || contentTitlesOutOfSync))) {
      this.lastKnownState.set(file.path, { title: currentTitle, h1: currentH1 });
      return;
    }

    this.syncingFiles.add(file.path);

    try {
      let targetText = "";
      let h1Updated = false;
      let titleUpdated = false;

      if (this.settings.syncTitle) {
        if (titleChanged && !h1Changed) {
          targetText = currentTitle;
          await this.updateH1InFile(file, fileCache, targetText);
          h1Updated = true;
        } else if (h1Changed && !titleChanged) {
          targetText = currentH1;
          await this.updateFrontMatterTitle(file, targetText);
          titleUpdated = true;
        } else {
          targetText = currentH1 || currentTitle;
          if (currentTitle !== targetText) {
            await this.updateFrontMatterTitle(file, targetText);
            titleUpdated = true;
          }
          if (currentH1 !== targetText) {
            await this.updateH1InFile(file, fileCache, targetText);
            h1Updated = true;
          }
        }
      } else {
        targetText = currentH1;
      }

      const finalTitle = titleUpdated ? targetText : currentTitle;
      const finalH1 = h1Updated ? targetText : currentH1;
      this.lastKnownState.set(file.path, { title: finalTitle, h1: finalH1 });

      if (this.settings.syncFilename && targetText) {
        await this.syncFilename(file, targetText);
      }
    } catch (err) {
      console.error("Error during note title/H1 sync:", err);
    } finally {
      this.syncingFiles.delete(file.path);
    }
  }

  async updateFrontMatterTitle(file: TFile, newTitle: string): Promise<void> {
    await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      if (newTitle) {
        frontmatter["title"] = newTitle;
      } else {
        delete frontmatter["title"];
      }
    });
  }

  async updateH1InFile(file: TFile, fileCache: CachedMetadata | null, newTitle: string): Promise<void> {
    const content = await this.app.vault.read(file);
    const lines = content.split("\n");
    const h1HeadingObj = fileCache?.headings?.find((h) => h.level === 1);

    if (h1HeadingObj) {
      const lineIndex = h1HeadingObj.position.start.line;
      if (lineIndex < lines.length && lines[lineIndex].trimStart().startsWith("# ")) {
        const match = lines[lineIndex].match(/^(\s*)#\s/);
        const prefix = match ? match[1] : "";
        lines[lineIndex] = `${prefix}# ${newTitle}`;
      } else {
        const foundIdx = lines.findIndex((l) => l.trimStart().startsWith("# "));
        if (foundIdx !== -1) {
          const match = lines[foundIdx].match(/^(\s*)#\s/);
          const prefix = match ? match[1] : "";
          lines[foundIdx] = `${prefix}# ${newTitle}`;
        } else {
          let insertLine = 0;
          if (fileCache?.frontmatterPosition) {
            insertLine = fileCache.frontmatterPosition.end.line + 1;
          }
          lines.splice(insertLine, 0, "", `# ${newTitle}`);
        }
      }
    } else {
      let insertLine = 0;
      if (fileCache?.frontmatterPosition) {
        insertLine = fileCache.frontmatterPosition.end.line + 1;
      }
      lines.splice(insertLine, 0, "", `# ${newTitle}`);
    }

    await this.app.vault.modify(file, lines.join("\n"));
  }

  async syncFilename(file: TFile, targetTitle: string): Promise<void> {
    const sanitized = this.sanitizeFilename(targetTitle);
    if (!sanitized) return;

    const parentPath = file.parent ? file.parent.path : "";
    const extension = file.extension || "md";

    let newPath = `${sanitized}.${extension}`;
    if (parentPath && parentPath !== "/" && parentPath !== "") {
      newPath = `${parentPath}/${sanitized}.${extension}`;
    }

    if (newPath === file.path) return;

    try {
      const existingFile = this.app.vault.getAbstractFileByPath(newPath);
      if (existingFile && existingFile.path !== file.path) {
        new Notice(`Cannot rename: File "${sanitized}.${extension}" already exists.`);
        console.warn(`Title H1 Filename Sync: file already exists at "${newPath}", skipping rename.`);
        return;
      }

      console.log(`Title H1 Filename Sync: renaming "${file.path}" -> "${newPath}"`);
      await this.app.fileManager.renameFile(file, newPath);
      if (this.settings.showRenameNotice) {
        new Notice(`Renamed note to "${sanitized}.${extension}"`);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      new Notice(`Failed to rename file: ${message}`);
      console.error("Title H1 Filename Sync: failed to rename file:", e);
    }
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  sanitizeFilename(name: string): string {
    if (!name) return "";
    let sanitized = name;
    const disallowed = this.settings?.disallowedChars || "";
    for (let i = 0; i < disallowed.length; i++) {
      const char = disallowed[i];
      sanitized = sanitized.split(char).join("");
    }
    sanitized = sanitized.replace(/\s+/g, " ").trim();
    const reservedNames = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;
    if (reservedNames.test(sanitized)) {
      sanitized = sanitized + "_safe";
    }
    if (sanitized.length > 200) {
      sanitized = sanitized.substring(0, 200).trim();
    }
    return sanitized;
  }
}

class TitleH1FilenameSyncSettingTab extends PluginSettingTab {
  plugin: TitleH1FilenameSyncPlugin;

  constructor(app: App, plugin: TitleH1FilenameSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Title H1 Filename Sync Settings" });

    new Setting(containerEl)
      .setName("Sync frontmatter title")
      .setDesc('If enabled, YAML frontmatter "title" property will be bidirectionally synced with the H1 heading.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.syncTitle).onChange(async (value) => {
          this.plugin.settings.syncTitle = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Sync filename")
      .setDesc("If enabled, the filename will be automatically updated to match the note H1 heading / frontmatter title.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.syncFilename).onChange(async (value) => {
          this.plugin.settings.syncFilename = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Disallowed characters in filename")
      .setDesc("Enter all characters that should be stripped out of the note filename.")
      .addText((text) =>
        text
          .setPlaceholder('*"\\/<>:|?')
          .setValue(this.plugin.settings.disallowedChars)
          .onChange(async (value) => {
            this.plugin.settings.disallowedChars = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Rename on Ctrl+S / Cmd+S")
      .setDesc("If enabled, pressing Ctrl+S or Cmd+S will immediately force the filename to sync with the note title.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.syncOnSave).onChange(async (value) => {
          this.plugin.settings.syncOnSave = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Show notice on rename")
      .setDesc("If enabled, a toast notification is shown whenever a note is renamed to match its title or H1 heading (and whenever a rename fails).")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showRenameNotice).onChange(async (value) => {
          this.plugin.settings.showRenameNotice = value;
          await this.plugin.saveSettings();
        })
      );
  }
}
