import type { Migration } from './index.js'

/**
 * Which audience a published payload was written for.
 *
 * Until now a day was published once, for the supervisor, and the teacher's consent flag on
 * an area was carried around without ever being read. Two people are going to log in to the
 * server, and they are not owed the same page: the supervisor at the internship and the
 * teacher at school have separate consent on every area, so the same day has to be prepared
 * twice and listed in two separate indexes.
 *
 * Null stays the right answer for an uploaded image: a frame is either approved or it is
 * not, and both audiences see the approved ones. Only the JSON payloads — the rows with no
 * artifact behind them — belong to one audience.
 *
 * Everything already online was written under the supervisor's rules, so that is what it is
 * labelled. Marking it as either would be a guess; marking it as the one it was built from
 * is a fact.
 */
export const migration017: Migration = {
  id: 17,
  name: 'publish-audience',
  sql: /* sql */ `
    ALTER TABLE published_files ADD COLUMN audience TEXT;

    UPDATE published_files
       SET audience = 'supervisor'
     WHERE artifact_id IS NULL;
  `
}
