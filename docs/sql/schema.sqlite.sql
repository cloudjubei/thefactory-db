PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('project_file','internal_document','external_blob')),
  content TEXT,
  tokenized_content TEXT,
  embedding TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  metadata TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
  id UNINDEXED,
  tokenized_content,
  tokenize = 'porter'
);

CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);

CREATE TRIGGER IF NOT EXISTS entities_ai AFTER INSERT ON entities BEGIN
  INSERT INTO entities_fts(id, tokenized_content) VALUES (new.id, coalesce(new.tokenized_content, ''));
END;
CREATE TRIGGER IF NOT EXISTS entities_au AFTER UPDATE ON entities BEGIN
  UPDATE entities_fts SET id=new.id, tokenized_content=coalesce(new.tokenized_content, '') WHERE id=old.id;
END;
CREATE TRIGGER IF NOT EXISTS entities_ad AFTER DELETE ON entities BEGIN
  DELETE FROM entities_fts WHERE id=old.id;
END;
