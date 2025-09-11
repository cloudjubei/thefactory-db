import type { DB } from './connection.js';

export type InitEntitiesOptions = {
  embeddingDimension?: number // default 1536
}

export function initEntitiesSchema(db: DB, opts: InitEntitiesOptions = {}): void {
  const dim = opts.embeddingDimension ?? 1536
  const hasVSS = false //TODO:

  const init = db.transaction(() => {
    // Base table
    db.exec(`
      CREATE TABLE IF NOT EXISTS entities (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        content TEXT,
        tokenized_content TEXT,
        embedding BLOB,
        createdAt DATETIME NOT NULL DEFAULT (datetime('now')),
        updatedAt DATETIME NOT NULL DEFAULT (datetime('now')),
        metadata JSON
      );
    `)

    // Keep updatedAt fresh on updates (avoid recursion with WHEN clause)
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_entities_updatedAt
      AFTER UPDATE ON entities
      FOR EACH ROW
      WHEN NEW.updatedAt = OLD.updatedAt
      BEGIN
        UPDATE entities SET updatedAt = datetime('now') WHERE rowid = NEW.rowid;
      END;
    `)

    // FTS5 index over tokenized_content using external content linking to entities by rowid
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts
      USING fts5(
        tokenized_content,
        content='entities',
        content_rowid='rowid'
      );
    `)

    // Triggers to sync FTS with entities
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_entities_ai_fts
      AFTER INSERT ON entities
      BEGIN
        INSERT INTO entities_fts(rowid, tokenized_content) VALUES (new.rowid, new.tokenized_content);
      END;
    `)

    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_entities_ad_fts
      AFTER DELETE ON entities
      BEGIN
        INSERT INTO entities_fts(entities_fts, rowid, tokenized_content)
        VALUES ('delete', old.rowid, old.tokenized_content);
      END;
    `)

    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_entities_au_fts
      AFTER UPDATE OF tokenized_content ON entities
      BEGIN
        INSERT INTO entities_fts(entities_fts, rowid, tokenized_content)
        VALUES ('delete', old.rowid, old.tokenized_content);
        INSERT INTO entities_fts(rowid, tokenized_content)
        VALUES (new.rowid, new.tokenized_content);
      END;
    `)

    // Vector index via sqlite-vss (if loaded)
    if (hasVSS) {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS entities_vss
        USING vss0(embedding(${dim}));
      `)

      db.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_entities_ai_vss
        AFTER INSERT ON entities
        WHEN NEW.embedding IS NOT NULL
        BEGIN
          INSERT INTO entities_vss(rowid, embedding) VALUES (new.rowid, new.embedding);
        END;
      `)

      db.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_entities_ad_vss
        AFTER DELETE ON entities
        BEGIN
          DELETE FROM entities_vss WHERE rowid = old.rowid;
        END;
      `)

      db.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_entities_au_vss
        AFTER UPDATE OF embedding ON entities
        BEGIN
          DELETE FROM entities_vss WHERE rowid = old.rowid;
          INSERT INTO entities_vss(rowid, embedding) VALUES (new.rowid, new.embedding);
        END;
      `)
    }
  })

  init()
}
