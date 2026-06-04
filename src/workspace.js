import { promises as fs } from 'node:fs';
import path from 'node:path';

function toPosixPath(value) {
  return value.split(path.sep).join('/');
}

function normalizeWorkspacePath(value) {
  return value
    .replace(/\\/gu, '/')
    .replace(/^\.\//u, '')
    .replace(/^\/+/u, '');
}

async function directoryExists(value) {
  try {
    const stats = await fs.stat(value);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

async function collectFiles(directory, rootDirectory = directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(fullPath, rootDirectory));
    } else if (entry.isFile()) {
      files.push(toPosixPath(path.relative(rootDirectory, fullPath)));
    }
  }

  return files;
}

export class FilesystemWorkspace {
  constructor(root) {
    this.root = path.resolve(root);
  }

  getRoot() {
    return this.root;
  }

  async exists() {
    return directoryExists(this.root);
  }

  async listFiles(prefix) {
    if (!await this.exists()) {
      return [];
    }

    if (prefix) {
      const normalizedPrefix = normalizeWorkspacePath(prefix);
      const directory = path.join(this.root, normalizedPrefix);
      if (!await directoryExists(directory)) {
        return [];
      }

      return (await collectFiles(directory)).map((file) => `${normalizedPrefix}/${file}`);
    }

    return collectFiles(this.root);
  }

  async readFile(file) {
    return fs.readFile(path.join(this.root, file), 'utf8');
  }

  resolveFile(file) {
    return path.join(this.root, file);
  }
}

export class InMemoryWorkspace {
  constructor(files, { root = '<memory>' } = {}) {
    this.root = root;
    this.files = new Map();

    for (const file of files) {
      this.files.set(normalizeWorkspacePath(file.path), file.content);
    }
  }

  getRoot() {
    return this.root;
  }

  async listFiles(prefix) {
    const files = [...this.files.keys()].sort();
    if (!prefix) {
      return files;
    }

    const normalizedPrefix = normalizeWorkspacePath(prefix);
    return files.filter((file) => file.startsWith(`${normalizedPrefix}/`));
  }

  async readFile(file) {
    const normalizedFile = normalizeWorkspacePath(file);
    if (!this.files.has(normalizedFile)) {
      throw new Error(`workspace file does not exist: ${file}`);
    }

    return this.files.get(normalizedFile);
  }

  resolveFile(file) {
    return normalizeWorkspacePath(file);
  }
}

export function createFilesystemWorkspace(root) {
  return new FilesystemWorkspace(root);
}

export function createInMemoryWorkspace(files, options) {
  return new InMemoryWorkspace(files, options);
}

export function isWorkspace(value) {
  return value !== null
    && typeof value === 'object'
    && typeof value.listFiles === 'function'
    && typeof value.readFile === 'function';
}

export function toWorkspace(value) {
  if (isWorkspace(value)) {
    return value;
  }

  return new FilesystemWorkspace(value);
}
