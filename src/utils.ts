import delete_entity_pg from '../docs/sql/delete_entity.pg.sql';
import get_entity_by_id_pg from '../docs/sql/get_entity_by_id.pg.sql';
import insert_entity_pg from '../docs/sql/insert_entity.pg.sql';
import schema_pg from '../docs/sql/schema.pg.sql';
import search_entities_pg from '../docs/sql/search_entities.pg.sql';
import update_entity_pg from '../docs/sql/update_entity.pg.sql';
import hybrid_search_pg from '../docs/sql/hybrid_search.pg.sql';

const SQLS: Record<string, string> = {
  delete_entity: delete_entity_pg,
  get_entity_by_id: get_entity_by_id_pg,
  insert_entity: insert_entity_pg,
  schema: schema_pg,
  search_entities: search_entities_pg,
  update_entity: update_entity_pg,
  hybrid_search: hybrid_search_pg,
};

export function readSql(name: string): string | undefined {
  const b64 = SQLS[name];
  if (b64 !== undefined) {
    return base64ToUtf8(b64);
  }
}

export function base64ToUtf8(base64: string) {
  if (base64.startsWith('data:')) {
    const base64Data = base64.split(',')[1];
    return atob(base64Data);
  }
  return atob(base64);
}
