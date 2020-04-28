import { DocumentController, ScopeInfoAPI, Token } from './document';
import fs from 'fs';
import * as oniguruma from 'vscode-oniguruma-wasm';
import { join } from 'path';
import { ExtensionContext, Extension, extensions, Memento, Position, TextDocument, Uri, workspace } from 'vscode';
import { IGrammar, IRawGrammar, parseRawGrammar, Registry, RegistryOptions } from 'vscode-textmate';

const documents = new Map<Uri, DocumentController>();
const cachedGrammars = new Map<string, IGrammar | Promise<IGrammar>>();
const wasm = fs.readFileSync(join(__dirname, '../../../node_modules/vscode-oniguruma-wasm/release/onig.wasm')).buffer;

oniguruma.loadWASM(wasm);

export let textMateRegistry: Registry;

interface ExtensionGrammar {
  language?: string;
  scopeName?: string;
  path?: string;
  embeddedLanguages?: { [scopeName: string]: string };
  injectTo?: string[];
}

interface ExtensionPackage {
  contributes?: {
    languages?: {
      id: string;
      configuration: string
    }[];
    grammars?: ExtensionGrammar[];
  };
}

function getLanguageScopeName(languageId: string): string {
  try {
    const languages =
      extensions.all
        .filter(x => x.packageJSON && x.packageJSON.contributes && x.packageJSON.contributes.grammars)
        .reduce((a: ExtensionGrammar[], b) => [...a, ...(b.packageJSON as ExtensionPackage).contributes.grammars], []);
    const matchingLanguages = languages.filter(g => g.language === languageId);

    if (matchingLanguages.length > 0)
      return matchingLanguages[0].scopeName;
  }
  catch (err) { }

  return undefined;
}

interface GrammarAndExtensionPath {
  grammar: ExtensionGrammar;
  path: string;
}

function groupGrammarsAndPath(grammars: ExtensionGrammar[], extension: Extension<any>): GrammarAndExtensionPath[] {
  if (!grammars)
    return [];

  return grammars.map(grammar => ({ grammar, path: extension.extensionPath }));
}

async function getLanguageGrammar(scopeName: string): Promise<IRawGrammar> {
  try {
    const languages =
      extensions.all
        .filter(x => x.packageJSON && x.packageJSON.contributes && x.packageJSON.contributes.grammars)
        .reduce((a: GrammarAndExtensionPath[], b) => [...a,
        ...groupGrammarsAndPath((b.packageJSON as ExtensionPackage).contributes.grammars, b)], []);
    const matchingLanguages = languages.filter(g => g.grammar.scopeName === scopeName);

    if (matchingLanguages.length > 0) {
      const path = join(matchingLanguages[0].path, matchingLanguages[0].grammar.path);
      const content = fs.readFileSync(path).toString();

      return parseRawGrammar(content, path);
    }
  }
  catch (err) { }

  return undefined;
}

const grammarLocator: RegistryOptions = {
  getInjections: null,
  loadGrammar: scopeName => getLanguageGrammar(scopeName),
  onigLib: Promise.resolve({
    createOnigScanner: sources => new oniguruma.OnigScanner(sources),
    createOnigString: str => new oniguruma.OnigString(str)
  })
};

export let workspaceState: Memento;

export function activate(context: ExtensionContext): ScopeInfoAPI {
  workspaceState = context.workspaceState;
  context.subscriptions.push(workspace.onDidOpenTextDocument(openDocument));
  context.subscriptions.push(workspace.onDidCloseTextDocument(closeDocument));

  reloadGrammar();

  return {
    getScopeAt(document: TextDocument, position: Position): Token {
      try {
        const prettyDoc = documents.get(document.uri);

        if (prettyDoc)
          return prettyDoc.getScopeAt(position);
      }
      catch (err) { }

      return null;
    },
    getScopeForLanguage(language: string): string | null {
      return getLanguageScopeName(language) || null;
    },
    async getGrammar(scopeName: string): Promise<IGrammar> {
      try {
        if (textMateRegistry)
          return await loadGrammar(scopeName);
      }
      catch (err) { }

      return null;
    }
  };
}

/** Re-read the settings and recreate substitutions for all documents */
function reloadGrammar(): void {
  try {
    textMateRegistry = new Registry(grammarLocator);
    cachedGrammars.clear();
  }
  catch (err) {
    textMateRegistry = undefined;
    console.error(err);
  }

  // Recreate the documents
  unloadDocuments();

  for (const doc of workspace.textDocuments)
    openDocument(doc);
}

function loadGrammar(scopeName: string): Promise<IGrammar> {
  if (cachedGrammars.has(scopeName)) {
    const grammar = cachedGrammars.get(scopeName);

    if (grammar instanceof Promise)
      return grammar;
    else
      return Promise.resolve(grammar);
  }

  const newGrammar = textMateRegistry.loadGrammar(scopeName);

  cachedGrammars.set(scopeName, newGrammar);

  return newGrammar;
}

async function openDocument(doc: TextDocument): Promise<void> {
  try {
    const prettyDoc = documents.get(doc.uri);

    if (prettyDoc)
      prettyDoc.refresh();
    else if (textMateRegistry) {
      const scopeName = getLanguageScopeName(doc.languageId);

      if (scopeName) {
        const grammar = await loadGrammar(scopeName);

        documents.set(doc.uri, new DocumentController(doc, grammar));
      }
    }
  }
  catch (err) {
    console.error(err);
  }
}

function closeDocument(doc: TextDocument): void {
  const prettyDoc = documents.get(doc.uri);

  if (prettyDoc) {
    prettyDoc.dispose();
    documents.delete(doc.uri);
  }
}

function unloadDocuments(): void {
  for (const prettyDoc of documents.values())
    prettyDoc.dispose();

  documents.clear();
}

export function deactivate(): void {
  unloadDocuments();
}