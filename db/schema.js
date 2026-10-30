import {sqliteTable,text,primaryKey} from 'drizzle-orm/sqlite-core';
export const documents=sqliteTable('documents',{
  collection:text('collection').notNull(),
  documentKey:text('document_key').notNull(),
  payload:text('payload').notNull(),
  updatedAt:text('updated_at').notNull(),
},table=>[primaryKey({columns:[table.collection,table.documentKey]})]);
