// Table sizing, column visibility and connector routing.
//
// The column visibility rules here mirror Export/ExportRowBuilder.cs on the host side. The canvas
// needs them synchronously on every redraw and the text exporters need them without a round trip,
// so the rules exist in both runtimes. Change one, change the other.

import { measureText, truncateToWidth } from './util.js';
import {
  state, tableById, visibleRelationships, annotationKind, topologyVersion, NOTE_DEFAULT_SIZE
} from './state.js';
import { palette, mix } from './theme.js';

export const METRICS = {
  headerHeight: 30,
  rowHeight: 20,
  padX: 9,
  markerWidth: 20,
  typeGap: 10,

  /// Gap between a column's display name and its schema name when both are shown on one row.
  secondaryGap: 8,

  minWidth: 172,
  maxWidth: 340,
  cornerRadius: 7,
  connectorGap: 14,
  channel: 34,
  noteTagWidth: 38,

  /// Width of the ownership pill in a card header.
  ownershipWidth: 34,
  jumpRadius: 5
};

export const FONTS = {
  title: '600 12px "Segoe UI", sans-serif',
  schema: '9.5px Consolas, monospace',
  row: '10.5px Consolas, monospace',
  rowDisplay: '11px "Segoe UI", sans-serif',
  type: '9.5px "Segoe UI", sans-serif',
  marker: '600 8.5px Consolas, monospace',
  badge: '600 8px "Segoe UI", sans-serif',
  edgeLabel: '10px Consolas, monospace',
  note: '12px "Segoe UI", sans-serif'
};

/**
 * Card styling per diagram status. Read through the active palette rather than a fixed table so
 * the same call site works in both themes; the light values are unchanged from before dark mode.
 */
export function statusStyle(status) {
  const styles = palette().status;
  return styles[status] || styles.Existing;
}

/** Mixes a hex colour towards the current theme's card background. */
export function tint(hex, amount) {
  return mix(hex, palette().tintTarget, amount);
}

// ------------------------------------------------------------- columns ---

/** Columns that should be drawn inside a table card for the current settings. */
export function visibleColumns(table) {
  const doc = state.doc;
  const mode = table.collapsed ? 'TablesOnly' : (table.detailOverride || doc.settings.fieldDetail);
  if (mode === 'TablesOnly') return [];

  const columns = table.columns || [];
  if (mode === 'AllFields') return orderColumns(columns.filter(c => c.selected !== false), doc.settings.fieldOrder);

  const wanted = new Set();
  if (table.primaryIdAttribute) wanted.add(table.primaryIdAttribute.toLowerCase());

  for (const relationship of visibleRelationships()) {
    if (relationship.toTableId === table.id && relationship.referencingAttribute) {
      wanted.add(relationship.referencingAttribute.toLowerCase());
    }
    if (relationship.fromTableId === table.id && relationship.referencedAttribute) {
      wanted.add(relationship.referencedAttribute.toLowerCase());
    }
  }

  if (doc.settings.showAlternateKeys) {
    for (const key of table.alternateKeys || []) {
      for (const column of key.columns || []) wanted.add(String(column).toLowerCase());
    }
  }

  let selected = columns.filter(c =>
    c.selected !== false &&
    (c.isPrimaryId || c.status === 'Proposed' || wanted.has(String(c.logicalName || '').toLowerCase())));

  // An empty card usually reads as a bug rather than a choice, so fall back to the primary name
  // column - but never to one the user has deliberately unticked in the inspector.
  if (!selected.length) {
    const available = columns.filter(c => c.selected !== false);
    const fallback = available.find(c => c.isPrimaryName) || available[0];
    if (fallback) selected = [fallback];
  }

  return orderColumns(selected, doc.settings.fieldOrder);
}

function orderColumns(columns, order) {
  const ranked = columns.slice();
  if (order === 'displayName') {
    ranked.sort((a, b) => String(a.displayName || '').localeCompare(String(b.displayName || ''), 'en-GB'));
  } else if (order === 'schemaName') {
    ranked.sort((a, b) => String(a.logicalName || '').localeCompare(String(b.logicalName || ''), 'en-GB'));
  }

  // Keys always float to the top whatever the sort, because that is what makes a card scannable.
  return ranked.sort((a, b) => rank(a) - rank(b));

  function rank(column) {
    if (column.isPrimaryId) return 0;
    if (column.isPrimaryName) return 1;
    if (column.isLookup) return 2;
    return 3;
  }
}

/**
 * The text drawn for one column row.
 *
 * Both name toggles are honoured independently, and both being off leaves the row showing the
 * schema name rather than nothing - a blank row is not a useful answer to "hide both names", and
 * the schema name is the one that identifies the column.
 *
 * This used to consult showFieldSchemaName only inside the both-on branch. Since showFieldDisplayName
 * is off by default, unticking "Column schema name" in Display settings changed nothing on the
 * canvas in the default configuration: a checkbox that did not do anything.
 */
export function columnLabel(column) {
  const settings = state.doc.settings;
  const schema = column.logicalName || column.schemaName || '';
  const display = column.displayName || schema;
  const differ = display.toLowerCase() !== schema.toLowerCase();

  // Defaults matched exactly: display name off, schema name on. Reading these as `!== false`
  // would turn a hand-edited file that omits them into one that draws both names on every row.
  const wantDisplay = settings.showFieldDisplayName === true;
  const wantSchema = settings.showFieldSchemaName !== false;

  if (wantDisplay && wantSchema && differ) {
    // Both asked for and genuinely different: the display name leads, with the schema name
    // appended in the muted secondary style so one row still carries both.
    return { primary: display, secondary: schema, font: FONTS.rowDisplay };
  }

  if (wantDisplay) return { primary: display, secondary: null, font: FONTS.rowDisplay };

  // Schema name, and also the fallback when both are off. A row with a key marker, a type and no
  // name at all identifies nothing, so the Display settings dialog does not let the user reach
  // that state: unticking one name toggle turns the other on (see dialogs.js).
  return { primary: schema, secondary: null, font: FONTS.row };
}

/**
 * Whether a card gets an ownership pill. Read by the renderer and by the card measurer below,
 * which have to agree exactly: if the measurer allows width the renderer does not use, the header
 * carries a gap; if the renderer draws a pill the measurer did not allow for, it overlaps the
 * title. They disagreed on reclassified tables - a real table marked Proposed kept the width and
 * lost the pill.
 */
export function hasOwnershipMark(table) {
  if (!state.doc.settings.showOwnership) return false;

  // A proposed or external table has no ownership until somebody creates it, so claiming one
  // would be inventing a design decision that has not been made.
  if (table.status !== 'Existing' && table.status !== 'Deprecated') return false;

  return !!table.ownershipType;
}

/**
 * Whether a card gets a NOTE tag. The same measurer/renderer contract hasOwnershipMark exists for:
 * the measurer reserved 44px of header for any non-empty string while the renderer only drew the
 * tag for one with visible text, so a note of nothing but spaces widened the card by exactly 44px
 * and then drew nothing in the space it bought.
 */
export function hasNote(table) {
  return !!(table && table.notes && String(table.notes).trim());
}

/**
 * Whether a column row gets the red asterisk that marks it mandatory.
 *
 * `isRequired` already carries both halves of what that means - MetadataService sets it for
 * ApplicationRequired *and* SystemRequired, and the proposed column editor's "Business required"
 * tick box writes the same flag - so there is nothing to work out here beyond reading it. It lives
 * in geometry.js rather than the renderer because the card size cache has to fold it into its
 * digest, and the rule for "is this row marked" has to be one rule rather than two.
 */
export function hasRequiredMark(column) {
  return !!(column && column.isRequired);
}

/**
 * How much of the marker gutter the asterisk takes, measured from the gutter's right-hand edge.
 *
 * The asterisk is drawn inside the width already reserved for PK/FK/AK rather than beside the
 * name, so it costs a card no width at all - which is the whole reason it cannot collide with a
 * truncated name or with the right-aligned type text. See appendRow in render.js for the
 * arithmetic that keeps it clear of the marker itself.
 */
export const REQUIRED_MARK_INSET = 2.5;

export function tableTitle(table) {
  const settings = state.doc.settings;
  const schema = table.logicalName || table.schemaName || '';
  const display = table.displayName || schema;

  if (settings.showTableDisplayName) return display;
  return schema || display;
}

export function tableSubtitle(table) {
  const settings = state.doc.settings;
  if (!settings.showTableSchemaName) return null;

  const schema = table.logicalName || table.schemaName || '';
  if (!schema) return null;

  // Compared against the title that will actually be drawn, whatever the display-name setting is.
  // The guard used to ask showTableDisplayName as well, so in the one configuration where the
  // title *is* the schema name - display names off, schema names on - it never fired and every
  // card header drew the schema name twice.
  if (schema.toLowerCase() === String(tableTitle(table) || '').toLowerCase()) return null;
  return schema;
}

// -------------------------------------------------------------- sizing ---

const sizeCache = new Map();
let sizeCacheKey = '';
let sizeCacheTopology = -1;

/**
 * Memoised column digests, keyed by the columns array itself. Declared here rather than beside
 * columnNameKey below because invalidateSizes empties it, and invalidateSizes is above.
 */
let nameKeyCache = new WeakMap();

/** Invalidate cached card sizes; call whenever display settings change. */
export function invalidateSizes() {
  sizeCache.clear();
  nameKeyCache = new WeakMap();
  sizeCacheKey = JSON.stringify(state.doc.settings);
}

export function measureTable(table) {
  const settingsKey = JSON.stringify(state.doc.settings);
  if (settingsKey !== sizeCacheKey) invalidateSizes();

  // Which relationships are visible decides which lookup rows a card draws under "relationship
  // fields", so it has to be part of what the cache is keyed on. It used to be the *count* of
  // visibleRelationships(), which was wrong twice over: two different sets of the same size share
  // a key - hide r1, hide r2, show r1 and the card kept r2's row, at r2's height, with r1's
  // connector then anchored to the header - and building that count walked every relationship
  // against every table, which cost more than the measurement the cache exists to avoid.
  //
  // state.js counts structural changes instead. Entries measured under an older topology can never
  // be asked for again, so the map is emptied rather than left to accumulate them.
  const topology = topologyVersion();
  if (topology !== sizeCacheTopology) {
    sizeCache.clear();
    sizeCacheTopology = topology;
  }

  // The per-column "selected" flags are part of the key: without them, unticking a column in the
  // inspector left the cached rows in place and the card never changed on the canvas.
  const selectionKey = (table.columns || [])
    .map(column => (column.selected === false ? '0' : '1')).join('');

  // Status and ownership are part of the key because both change the *width*: a non-Existing card
  // reserves 62px for its status badge, and hasOwnershipMark - which is false for anything other
  // than Existing and Deprecated - reserves the ownership pill. Without them, "mark as deprecated"
  // on a card already measured left the badge drawn into a width that never allowed for it, and
  // the title was truncated to make room that was not there. The renderer and the measurer have to
  // agree exactly; that is the whole contract hasOwnershipMark exists to hold.
  //
  // The table's own three names are here because they are what the title is drawn from and the
  // title is what sets the minimum width; primaryIdAttribute and the alternate keys because they
  // decide which columns are wanted. Every path that edits one calls invalidateSizes by hand, so
  // they were only ever right by convention - and undo, which swaps in a clone rather than calling
  // anything, is not one of those paths.
  const key = table.id + '|' + (table.width || 0) + '|' + (table.detailOverride || '') +
              '|' + (table.collapsed ? 1 : 0) + '|' + (table.columns || []).length +
              '|' + selectionKey + '|' + (hasNote(table) ? 1 : 0) +
              '|' + (table.status || '') + '|' + (table.ownershipType || '') +
              '|' + (table.displayName || '') + '~' + (table.logicalName || '') +
              '~' + (table.schemaName || '') + '|' + (table.primaryIdAttribute || '') +
              '|' + alternateKeyKey(table) +
              '|' + columnNameKey(table) +
              '|' + topology;

  const cached = sizeCache.get(key);
  if (cached) return cached;

  const columns = visibleColumns(table);
  const rows = columns.map(column => {
    const label = columnLabel(column);
    const marker = markerFor(column);
    const type = state.doc.settings.showFieldType ? (column.typeName || '') : '';
    return { column, label, marker, type };
  });

  let contentWidth = METRICS.minWidth;

  const titleWidth = measureText(tableTitle(table), FONTS.title) +
                     (tableSubtitle(table) ? measureText(tableSubtitle(table), FONTS.schema) + 12 : 0) +
                     (table.status !== 'Existing' && state.doc.settings.showStatusBadges ? 62 : 0) +
                     (hasNote(table) ? METRICS.noteTagWidth + 6 : 0) +
                     (hasOwnershipMark(table) ? METRICS.ownershipWidth + 6 : 0) +
                     METRICS.padX * 2 + 14;

  contentWidth = Math.max(contentWidth, titleWidth);

  for (const row of rows) {
    const width = METRICS.padX * 2 + METRICS.markerWidth +
                  measureText(row.label.primary, row.label.font) +
                  // The secondary name is drawn on the same line when both name toggles are on,
                  // so the card has to be wide enough for it or it would simply be truncated away.
                  (row.label.secondary ? METRICS.secondaryGap + measureText(row.label.secondary, FONTS.row) : 0) +
                  (row.type ? METRICS.typeGap + measureText(row.type, FONTS.type) : 0);
    contentWidth = Math.max(contentWidth, width);
  }

  const width = table.width || Math.min(METRICS.maxWidth, Math.ceil(contentWidth));
  const height = METRICS.headerHeight + rows.length * METRICS.rowHeight + (rows.length ? 4 : 0);

  const size = { width, height, rows };
  sizeCache.set(key, size);
  return size;
}

/**
 * The alternate keys as they affect what is drawn, which is only while the setting that shows them
 * is on. Off - and it is off by default - a document pays nothing for keys it never draws.
 */
function alternateKeyKey(table) {
  if (!state.doc.settings.showAlternateKeys) return '';
  return (table.alternateKeys || []).map(key => (key.columns || []).join(',')).join(';');
}

/**
 * A digest of everything about a table's columns that changes the rows drawn for it.
 *
 * The count and the selected flags were in the cache key already; the *names*, types and statuses
 * were not, and every path that changes one of those was expected to call invalidateSizes by hand.
 * Undo and redo do not - they swap in a clone of the document, so a renamed column comes back under
 * a key that has not changed and the card keeps drawing the name that was undone. Worse, the cached
 * rows hold references into the discarded document, so later edits to the live columns are
 * invisible as well.
 *
 * A rolling hash rather than a joined string, memoised against the columns array itself. Both
 * matter: measureTable is reached several times per card per frame - once for the card and once for
 * each end of every connector touching it - and a two-hundred-column card at "all fields" made that
 * measurably slower to pan. The array is the right key because the case this exists for is undo,
 * which swaps in a clone and therefore a new array; an edit in place leaves the array identity
 * alone, and every path that does one already calls invalidateSizes, which empties this too.
 */
function columnNameKey(table) {
  const columns = table.columns;
  if (!columns || !columns.length) return 0;

  const cached = nameKeyCache.get(columns);
  if (cached !== undefined) return cached;

  let hash = 5381;

  const fold = value => {
    const text = String(value || '');
    for (let i = 0; i < text.length; i++) hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
    hash = ((hash * 33) ^ 31) >>> 0;
  };

  for (const column of columns) {
    fold(column.logicalName || column.schemaName);
    fold(column.displayName);
    fold(column.typeName);
    fold(column.status);

    // The key flags as one nibble. They decide the marker drawn on the row, where the row sorts,
    // and under "relationship fields" whether the row is drawn at all - so a card measured before
    // a column became the primary name, or stopped being a lookup, is measured wrong.
    //
    // isRequired joins them for the mandatory asterisk. It costs no width - the asterisk is drawn
    // inside the marker gutter - so the *size* is the same either way, but the cached entry also
    // holds the row's `column` reference, and undo swaps in a clone rather than editing in place.
    // Without this bit, undoing a "Business required" tick produced an identical digest, the card
    // was served from the cache, and the rows it drew still pointed at the discarded document.
    const flags = (column.isPrimaryId ? 1 : 0) | (column.isPrimaryName ? 2 : 0) |
                  (column.isLookup ? 4 : 0) | (column.isAlternateKey ? 8 : 0) |
                  (hasRequiredMark(column) ? 16 : 0);
    hash = ((hash * 33) ^ flags) >>> 0;
  }

  nameKeyCache.set(columns, hash);
  return hash;
}

function markerFor(column) {
  const settings = state.doc.settings;
  if (column.isPrimaryId && settings.showPrimaryKey) return 'PK';
  if (column.isLookup && settings.showForeignKey) return 'FK';
  if (column.isAlternateKey && settings.showAlternateKeys) return 'AK';
  return '';
}

export function tableRect(table) {
  const size = measureTable(table);
  return { x: table.x, y: table.y, width: size.width, height: size.height, ...size };
}

/**
 * The bounding box of an annotation, whatever kind it is.
 *
 * An arrow has no width and height of its own - it is a start point and a vector, and either can
 * be negative - so every caller that needs to know where annotations are has to come through here
 * rather than reading `width`/`height` directly. Reading them directly is how an arrow drawn up and
 * to the left ends up outside Fit, outside the export bounds and unselectable by marquee.
 */
export function annotationRect(annotation) {
  if (!annotation) return { x: 0, y: 0, width: 0, height: 0 };

  if (annotationKind(annotation) === 'arrow') {
    const endX = annotation.x + (Number(annotation.dx) || 0);
    const endY = annotation.y + (Number(annotation.dy) || 0);

    return {
      x: Math.min(annotation.x, endX),
      y: Math.min(annotation.y, endY),
      width: Math.abs(endX - annotation.x),
      height: Math.abs(endY - annotation.y)
    };
  }

  // The same defaults and the same floors the renderer uses, so the box the marquee tests against
  // and the box Fit allows for are the box that is actually drawn. They disagreed - 240x96 here
  // against a sticky note's square and 220x40 for a text box - which only bites a hand-edited
  // or pre-1.6.0 file with no size on it, but bites it in three places at once. The note default
  // is NOTE_DEFAULT_SIZE rather than a number written out here, for the same reason.
  const text = annotationKind(annotation) === 'text';

  return {
    x: annotation.x,
    y: annotation.y,
    width: Math.max(120, Number(annotation.width) || (text ? 220 : NOTE_DEFAULT_SIZE)),
    height: Math.max(text ? 24 : 56, Number(annotation.height) || (text ? 40 : NOTE_DEFAULT_SIZE))
  };
}

/**
 * How far a sticky note is tilted, in degrees, positive clockwise.
 *
 * An explicit `annotation.tilt` wins: since 1.10.0 a selected note has a rotation handle above it,
 * and a note the user has turned by hand carries the angle they chose. Zero is a real answer there
 * - a note deliberately straightened - which is why the test is on the *type* and not on the
 * value.
 *
 * With nothing stored the angle is derived from the note's own id, so it is stable for the life of
 * the note - including across a save and reopen - without writing a property nobody chose. A
 * random tilt per render would make the canvas twitch on every redraw; the same tilt for every
 * note would look like a grid rather than paper.
 *
 * The derived angle is up to five degrees either way. The first version went to 2.2 and read as a
 * rendering wobble rather than as a deliberate slant, which is what it is there to say.
 *
 * It lives here rather than in render.js because annotationBounds needs it too, and render.js
 * imports geometry.js and never the reverse.
 */
export function stickyTilt(annotation) {
  if (!annotation) return 0;
  if (typeof annotation.tilt === 'number' && isFinite(annotation.tilt)) return annotation.tilt;

  const id = String(annotation.id || '');
  let hash = 7;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) % 100000;

  return ((hash % 101) - 50) / 10;
}

/**
 * The envelope a drawn annotation actually occupies. A sticky note is drawn rotated about its own
 * centre, so its corners reach past the rectangle it is placed in - at the 1.7.0 tilt of up to five
 * degrees a 240x96 note reaches about ten pixels beyond its own box, where at 2.2 degrees it
 * reached four and nobody noticed.
 *
 * This is the box for anything asking what is on the canvas: the marquee, Fit, and the exported
 * drawing. It is deliberately NOT `annotationRect`, which is the placed rectangle a resize drag is
 * seeded from - growing that by the tilt would make every resize inflate the note a little more.
 *
 * The magnitudes of the sine and cosine are what the envelope is made of, not their signs. That
 * did not matter while the only angles were the derived five degrees either way; the 1.10.0
 * rotation handle turns a note as far as the user likes, and past 90 degrees a signed cosine
 * subtracts one side from the other and hands back a box narrower than the note itself - which
 * Fit and every picture export would then cut the note off inside.
 */
export function annotationBounds(annotation) {
  const rect = annotationRect(annotation);
  if (annotationKind(annotation) !== 'note') return rect;

  const radians = stickyTilt(annotation) * Math.PI / 180;
  if (!radians) return rect;

  const cos = Math.abs(Math.cos(radians));
  const sin = Math.abs(Math.sin(radians));
  const width = rect.width * cos + rect.height * sin;
  const height = rect.width * sin + rect.height * cos;

  return {
    x: rect.x - (width - rect.width) / 2,
    y: rect.y - (height - rect.height) / 2,
    width,
    height
  };
}

/**
 * The box everything drawn on the canvas fits inside, plus padding. Used to size an export and to
 * fit the view.
 *
 * Connectors are measured, not just cards and annotations. A route is not inside the union of the
 * two cards it joins: a dead-level run that has been dragged is lifted clear of both of them, a
 * dragged diagonal pushes its middle segment out sideways, and every self-loop stands 30px plus
 * its fan spread past the card edge before anybody touches it. An export sized to the cards alone
 * simply cut them off - a connector dragged 900px down ran to y=915 in a drawing whose bottom edge
 * was 78.
 */
export function documentBounds(padding) {
  const pad = padding === undefined ? 60 : padding;
  const rects = state.doc.tables.map(tableRect);

  for (const annotation of state.doc.annotations || []) rects.push(annotationBounds(annotation));

  if (!rects.length) return { x: 0, y: 0, width: 800, height: 600 };

  let minX = Math.min(...rects.map(r => r.x));
  let minY = Math.min(...rects.map(r => r.y));
  let maxX = Math.max(...rects.map(r => r.x + r.width));
  let maxY = Math.max(...rects.map(r => r.y + r.height));

  // Routed exactly as the renderer routes them - same grouping, same fan order - so the box is
  // measured against the points that will be drawn rather than an approximation of them.
  for (const group of groupRelationships(visibleRelationships()).values()) {
    group.forEach((relationship, index) => {
      const route = routeRelationship(relationship, index, group.length);
      if (!route) return;

      for (const point of route.points) {
        if (point.x < minX) minX = point.x;
        if (point.y < minY) minY = point.y;
        if (point.x > maxX) maxX = point.x;
        if (point.y > maxY) maxY = point.y;
      }
    });
  }

  return {
    x: minX - pad,
    y: minY - pad,
    width: (maxX - minX) + pad * 2,
    height: (maxY - minY) + pad * 2
  };
}

// -------------------------------------------------------------- routing ---

/**
 * Groups relationships by unordered table pair so several connectors between the same two tables
 * can be fanned out instead of drawn on top of each other.
 */
export function groupRelationships(relationships) {
  const groups = new Map();
  for (const relationship of relationships) {
    const a = relationship.fromTableId;
    const b = relationship.toTableId;
    const key = a < b ? a + '|' + b : b + '|' + a;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(relationship);
  }
  return groups;
}

/** Vertical centre of the row showing a given column, or null when that column is not on the card. */
function rowCentreY(rect, attributeName) {
  if (!attributeName) return null;

  const wanted = String(attributeName).toLowerCase();
  const rows = rect.rows || [];
  const index = rows.findIndex(row => {
    const column = row.column || {};
    return String(column.logicalName || column.schemaName || '').toLowerCase() === wanted;
  });

  if (index < 0) return null;
  return rect.y + METRICS.headerHeight + index * METRICS.rowHeight + METRICS.rowHeight / 2;
}

/** Vertical centre of the card's primary-key row, or null when that row is not drawn. */
function primaryKeyRowY(rect) {
  const rows = rect.rows || [];
  const index = rows.findIndex(row => (row.column || {}).isPrimaryId);

  if (index < 0) return null;
  return rect.y + METRICS.headerHeight + index * METRICS.rowHeight + METRICS.rowHeight / 2;
}

/**
 * Where a horizontal connector meets a card. It points at the column the relationship actually
 * uses when that column is drawn; otherwise it meets the middle of the header rather than its
 * bottom edge, so it reads as "this table" instead of pointing at whichever field happens to be
 * first.
 *
 * The one end of a *proposed* 1:N takes a second try before it settles for the header: the row the
 * card itself calls its primary key. What a lookup holds is the other table's primary key, so that
 * row is the right target whether or not `referencedAttribute` has been filled in - and on a
 * proposal it is derived rather than read from Dataverse, so it can still be empty when the table
 * at the one end has not named its key yet. An existing relationship's referenced attribute comes
 * from the metadata and is already right; if the column it names is not on the card, the card
 * genuinely is not showing it and the header is the honest answer.
 *
 * Deliberately a fallback rather than an override. A named attribute that *is* drawn still wins,
 * and a primary key the user has unticked in the inspector is not drawn at all, so this never
 * puts back a row somebody has taken off the card - it lands on the header, same as before.
 */
function anchorY(rect, attributeName, fallBackToPrimaryKey) {
  const row = rowCentreY(rect, attributeName);
  if (row !== null) return row;

  if (fallBackToPrimaryKey) {
    const key = primaryKeyRowY(rect);
    if (key !== null) return key;
  }

  return rect.y + METRICS.headerHeight / 2;
}

function clampBetween(value, a, b) {
  const low = Math.min(a, b);
  const high = Math.max(a, b);
  return high <= low ? (a + b) / 2 : Math.max(low, Math.min(high, value));
}

/**
 * Orthogonal route between two table cards. Returns the path points, the two end anchors, the
 * side each anchor sits on so markers can be oriented, and which axis a manual drag moves the
 * middle of the route along.
 *
 * End anchors never move with the manual offset: dragging a connector separates it from the ones
 * it overlaps without changing what either end points at.
 */
export function routeRelationship(relationship, offsetIndex, offsetCount) {
  const from = tableById(relationship.fromTableId);
  const to = tableById(relationship.toTableId);
  if (!from || !to) return null;

  const a = tableRect(from);
  const b = tableRect(to);

  const spread = ((offsetIndex || 0) - ((offsetCount || 1) - 1) / 2) * METRICS.connectorGap;
  const manual = Number(relationship.routeOffset) || 0;
  const nudge = spread + manual;

  if (from.id === to.id) return selfLoop(a, spread, manual);

  const aCentre = { x: a.x + a.width / 2, y: a.y + a.height / 2 };
  const bCentre = { x: b.x + b.width / 2, y: b.y + b.height / 2 };

  const dx = bCentre.x - aCentre.x;
  const dy = bCentre.y - aCentre.y;

  const horizontal = Math.abs(dx) >= Math.abs(dy);

  if (horizontal) {
    const goingRight = dx >= 0;

    // Only a proposal gets the primary-key fallback at its one end - see anchorY. A vertical route
    // meets the top or bottom edge of a card and has never pointed at a row at all, so this is the
    // one branch it can apply to.
    const derivedKey = relationship.status === 'Proposed';

    const start = { x: goingRight ? a.x + a.width : a.x, y: anchorY(a, relationship.referencedAttribute, derivedKey) };
    const end = { x: goingRight ? b.x : b.x + b.width, y: anchorY(b, relationship.referencingAttribute) };

    const level = Math.abs(start.y - end.y) < 0.5;
    let points;
    let offsetAxis;

    if (level) {
      // A dead-straight run has no middle segment to shift sideways, so the offset lifts the
      // span instead. Two connectors that would sit exactly on top of each other can be parted.
      offsetAxis = 'y';
      if (Math.abs(nudge) < 0.5) {
        points = [start, end];
      } else {
        const direction = goingRight ? 1 : -1;
        const stub = Math.max(14, Math.min(34, Math.abs(end.x - start.x) / 3));
        const x1 = start.x + stub * direction;
        const x2 = end.x - stub * direction;
        points = [
          start,
          { x: x1, y: start.y },
          { x: x1, y: start.y + nudge },
          { x: x2, y: end.y + nudge },
          { x: x2, y: end.y },
          end
        ];
      }
    } else {
      offsetAxis = 'x';
      const midX = clampBetween((start.x + end.x) / 2 + nudge, start.x + 12, end.x - 12 * (goingRight ? 1 : -1));
      points = [start, { x: midX, y: start.y }, { x: midX, y: end.y }, end];
    }

    return {
      points,
      start,
      end,
      startSide: goingRight ? 'right' : 'left',
      endSide: goingRight ? 'left' : 'right',
      offsetAxis,
      label: midpointOf(points)
    };
  }

  const goingDown = dy >= 0;
  const start = {
    x: clampToRect(aCentre.x + spread, a.x, a.x + a.width),
    y: goingDown ? a.y + a.height : a.y
  };
  const end = {
    x: clampToRect(bCentre.x + spread, b.x, b.x + b.width),
    y: goingDown ? b.y : b.y + b.height
  };

  const level = Math.abs(start.x - end.x) < 0.5;
  let points;
  let offsetAxis;

  if (level) {
    offsetAxis = 'x';
    if (Math.abs(manual) < 0.5) {
      points = [start, end];
    } else {
      const direction = goingDown ? 1 : -1;
      const stub = Math.max(14, Math.min(34, Math.abs(end.y - start.y) / 3));
      const y1 = start.y + stub * direction;
      const y2 = end.y - stub * direction;
      points = [
        start,
        { x: start.x, y: y1 },
        { x: start.x + manual, y: y1 },
        { x: end.x + manual, y: y2 },
        { x: end.x, y: y2 },
        end
      ];
    }
  } else {
    offsetAxis = 'y';
    const midY = clampBetween((start.y + end.y) / 2 + nudge, start.y + 12, end.y - 12 * (goingDown ? 1 : -1));
    points = [start, { x: start.x, y: midY }, { x: end.x, y: midY }, end];
  }

  return {
    points,
    start,
    end,
    startSide: goingDown ? 'bottom' : 'top',
    endSide: goingDown ? 'top' : 'bottom',
    offsetAxis,
    label: midpointOf(points)
  };
}

function selfLoop(rect, spread, manual) {
  const out = Math.max(16, 30 + Math.abs(spread) + (manual || 0));
  const top = rect.y + rect.height * 0.3;
  const bottom = rect.y + rect.height * 0.7;
  const right = rect.x + rect.width;

  const points = [
    { x: right, y: top },
    { x: right + out, y: top },
    { x: right + out, y: bottom },
    { x: right, y: bottom }
  ];

  return {
    points,
    start: points[0],
    end: points[3],
    startSide: 'right',
    endSide: 'right',
    offsetAxis: 'x',
    label: { x: right + out + 6, y: (top + bottom) / 2 }
  };
}

function clampToRect(value, min, max) {
  const inset = 12;
  return Math.max(min + inset, Math.min(max - inset, value));
}

function midpointOf(points) {
  if (points.length <= 2) {
    return { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
  }
  const a = points[Math.floor((points.length - 1) / 2)];
  const b = points[Math.floor((points.length - 1) / 2) + 1];
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function pathFromPoints(points, radius, jumps) {
  if (!points || points.length < 2) return '';
  const r = radius === undefined ? 6 : radius;
  const hops = jumps && jumps.length ? jumps : null;

  let d = 'M ' + round(points[0].x) + ' ' + round(points[0].y);
  let cursor = points[0];

  for (let i = 1; i < points.length - 1; i++) {
    const previous = points[i - 1];
    const current = points[i];
    const next = points[i + 1];

    const inLength = Math.hypot(current.x - previous.x, current.y - previous.y);
    const outLength = Math.hypot(next.x - current.x, next.y - current.y);
    const corner = Math.min(r, inLength / 2, outLength / 2);

    const enter = pointTowards(current, previous, corner);
    const exit = pointTowards(current, next, corner);

    d += straightRun(cursor, enter, hops);
    d += ' Q ' + round(current.x) + ' ' + round(current.y) + ' ' + round(exit.x) + ' ' + round(exit.y);
    cursor = exit;
  }

  d += straightRun(cursor, points[points.length - 1], hops);
  return d;
}

/**
 * One straight leg of a route, with a small semicircular hop wherever it crosses a connector that
 * was drawn earlier. Only horizontal legs hop, so a crossing produces one bridge rather than two.
 */
function straightRun(from, to, hops) {
  const horizontal = Math.abs(to.y - from.y) < 0.01;
  if (!hops || !horizontal) return ' L ' + round(to.x) + ' ' + round(to.y);

  const direction = to.x >= from.x ? 1 : -1;
  const radius = METRICS.jumpRadius;

  const onThisRun = hops
    .filter(hop =>
      Math.abs(hop.y - from.y) < 0.5 &&
      (hop.x - from.x) * direction > radius + 1 &&
      (to.x - hop.x) * direction > radius + 1)
    .sort((a, b) => (a.x - b.x) * direction);

  let d = '';
  for (const hop of onThisRun) {
    d += ' L ' + round(hop.x - radius * direction) + ' ' + round(from.y);
    d += ' A ' + radius + ' ' + radius + ' 0 0 ' + (direction > 0 ? 1 : 0) + ' ' +
         round(hop.x + radius * direction) + ' ' + round(from.y);
  }

  return d + ' L ' + round(to.x) + ' ' + round(to.y);
}

/** Straight legs of a route, as axis-aligned segments. */
export function segmentsOf(points) {
  const segments = [];
  for (let i = 0; i < (points || []).length - 1; i++) {
    segments.push({ a: points[i], b: points[i + 1] });
  }
  return segments;
}

/**
 * Points where this route's horizontal legs cross the vertical legs of routes already drawn.
 * Crossings very close to a corner or an end anchor are ignored: a bridge there reads as a kink.
 */
export function crossingPoints(points, priorSegments) {
  const found = [];
  if (!priorSegments || !priorSegments.length) return found;

  const clearance = METRICS.jumpRadius + 3;

  for (const own of segmentsOf(points)) {
    if (Math.abs(own.a.y - own.b.y) >= 0.5) continue;

    const left = Math.min(own.a.x, own.b.x);
    const right = Math.max(own.a.x, own.b.x);
    const y = own.a.y;

    for (const other of priorSegments) {
      if (Math.abs(other.a.x - other.b.x) >= 0.5) continue;

      const x = other.a.x;
      const top = Math.min(other.a.y, other.b.y);
      const bottom = Math.max(other.a.y, other.b.y);

      if (x <= left + clearance || x >= right - clearance) continue;
      if (y <= top + clearance || y >= bottom - clearance) continue;

      if (!found.some(hop => Math.abs(hop.x - x) < 1 && Math.abs(hop.y - y) < 1)) {
        found.push({ x, y });
      }
    }
  }

  return found;
}

function pointTowards(from, to, distance) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  return { x: from.x + (dx / length) * distance, y: from.y + (dy / length) * distance };
}

export function round(value) {
  return Math.round(value * 100) / 100;
}

export function pointInRect(point, rect) {
  return point.x >= rect.x && point.x <= rect.x + rect.width &&
         point.y >= rect.y && point.y <= rect.y + rect.height;
}

export function rectsIntersect(a, b) {
  return !(b.x > a.x + a.width || b.x + b.width < a.x || b.y > a.y + a.height || b.y + b.height < a.y);
}

/** Shortest distance from a point to a polyline, used for connector hit testing. */
export function distanceToPolyline(point, points) {
  let best = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    best = Math.min(best, distanceToSegment(point, points[i], points[i + 1]));
  }
  return best;
}

function distanceToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (!lengthSquared) return Math.hypot(p.x - a.x, p.y - a.y);

  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export { truncateToWidth };
