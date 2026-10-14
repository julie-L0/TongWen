export type Role = 'unconfigured' | 'anchor' | 'sync' | 'history';
export type Block = {
  id: string;
  kind: 'paragraph' | 'heading' | 'list_item' | 'list' | 'table' | 'blockquote' | 'code_block';
  text: string;
  level?: number;
  locator?: { assetId: string; page: number; bbox?: { x: number; y: number; width: number; height: number } };
};
export type Document = {
  id: string;
  title: string;
  format: 'md' | 'pdf';
  assetPath: string | null;
  headVersionId: string;
  revision: number;
  createdAt: string;
};
export type Version = {
  id: string;
  documentId: string;
  seq: number;
  hash: string;
  blocks: Block[];
  reason: string;
  createdAt: string;
  label?: string;
  sourceName?: string;
};
export type Scope = { id: string; name: string; revision: number };
export type Folder = { id: string; name: string; parentId: string | null };
export type Presentation = {
  documentId: string;
  displayName: string;
  fileName: string;
  folderId: string | null;
};
export type Membership = {
  id: string;
  scopeId: string;
  documentId: string;
  role: Role;
  pinVersionId: string | null;
  baselineVersionId: string;
  compareDocumentId: string | null;
};
export type View = {
  member: Membership;
  scope: Scope;
  document: Document;
  version: Version;
  baseline: Version;
  editable: boolean;
};
export type Patch =
  | { kind: 'replace_text'; blockId: string; before: string; after: string }
  | { kind: 'insert_block'; afterBlockId: string | null; block: Omit<Block, 'id'> }
  | { kind: 'remove_block'; blockId: string; expectedText: string };
export type Operation = {
  id: string;
  documentId: string;
  memberId: string;
  beforeVersionId: string;
  afterVersionId: string;
  expectedRevision: number;
  requestId: string;
  createdAt: string;
  undoneAt: string | null;
};
export type Delta = {
  kind: 'added' | 'removed' | 'updated' | 'moved';
  blockId: string;
  before: Block | null;
  after: Block | null;
};
export type ImportItem = {
  name: string;
  text: string;
  role: Role;
  existingDocumentId?: string;
  compareDocumentId?: string;
};
export type Decision = {
  id: string;
  issueKey: string;
  sourceHash: string;
  targetHash: string;
  policyHash: string;
  action: 'retain' | 'defer';
  reason: string;
  createdAt: string;
  revokedAt: string | null;
};

// HTTP value contracts contain no rules, storage, React or Node dependencies.
export type Snapshot = {
  views: View[];
  scopes: Scope[];
  operations: Operation[];
  decisions: Decision[];
  stage: string;
  folders: Folder[];
  presentations: Presentation[];
  layoutRevision: number;
};
export type Comparison = {
  before: Version;
  after: Version;
  sameDocument: boolean;
  deltas: Delta[];
  kind: string;
  semanticAnalysis: false;
};
