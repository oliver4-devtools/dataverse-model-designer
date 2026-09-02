// The diagram document, undo history and selection.
//
// One deliberate normalisation happens here: Dataverse reports the same physical 1:N
// relationship twice, once as OneToMany from the "one" side and once as ManyToOne from the
// "many" side. Both carry the same referenced/referencing pair, so the document always stores
// fromTableId = referenced (the one end) and toTableId = referencing (the many end), and the
// kind is normalised to OneToMany. Direction then lives in one place instead of two, and the
// inspector states it in words so nothing is ambiguous on screen.

import { clone, uid } from './util.js';

const HISTORY_LIMIT = 60;
// Kept in step with DiagramDocument.CurrentFormatVersion. The host stamps the real value on
// save, so this only matters for a document that never reaches the host - but a mismatch here
// reads as a bug to the next person, and did.
const FORMAT_VERSION = 2;

const subscribers = new Set();

export const state = {
  doc: newDocument(),
  path: null,
  dirty: false,
  connection: { connected: false },
  settings: null,

  /** Environment table catalogue once read, so panels can search it. Owned by sourcepicker.js. */
  catalogue: null,

  selection: { tables: new Set(), relationships: new Set(), annotations: new Set() },
  hover: null,

  /** { fromTableId } while connect mode is armed, otherwise null. Owned by interact.js. */
  connect: null,

  /**
   * { tool } while a draw tool is armed - 'note', 'text' or 'arrow' - otherwise null.
   * Owned by interact.js, and mutually exclusive with connect above: both change what the next
   * click on the canvas means, so arming one disarms the other.
   */
  draw: null,

  /** Live preview of an arrow being dragged out. Transient; never part of the document. */
  pendingArrow: null,

  /**
   * Diagram id of the table whose note is open on the canvas, or null.
   *
   * Transient view state, deliberately not part of the document: which note happened to be open
   * when a diagram was saved is nobody's design decision, and it must never reach an export.
   */
  openNote: null,

  view: { zoom: 1, panX: 60, panY: 90 },
  filters: {
    relationshipTypes: new Set(['OneToMany', 'ManyToMany']),
    showExcluded: true,
    customOnly: false,
    /** Diagram id of a table to narrow the relationship list to, or null for all of them. */
    tableId: null,
    search: ''
  },
  highlightPath: null
};

let undoStack = [];
let redoStack = [];

export function newDocument(title) {
  return {
    formatVersion: FORMAT_VERSION,
    id: uid('d'),
    title: title || 'Untitled diagram',
    description: '',
    createdUtc: new Date().toISOString(),
    modifiedUtc: new Date().toISOString(),
    source: {},
    settings: defaultSettings(),
    view: { zoom: 1, panX: 60, panY: 90 },
    tables: [],
    relationships: [],
    annotations: []
  };
}

export function defaultSettings() {
  return {
    // No displayProfile. It was a named bundle of display settings that nothing had read since
    // 1.1, and format version 2 removed it from the host model and strips it from any version 1
    // file on the way in. Writing it here would have put it straight back into every new diagram
    // the migration exists to clean up.
    fieldDetail: 'RelationshipFields',
    layoutMode: 'Auto',
    autoLayoutOnAdd: true,
    fieldOrder: 'metadata',
    showTableDisplayName: true,
    showTableSchemaName: true,
    showFieldDisplayName: false,
    showFieldSchemaName: true,
    showFieldType: true,
    showPrimaryKey: true,
    showForeignKey: true,
    showRelationshipName: false,
    showCardinality: true,
    showCascade: false,
    showStatusBadges: true,
    showOwnership: false,
    showLegend: true,

    // Where the legend has been dragged to, in CSS pixels from the top-left of the window. Null
    // means the corner the stylesheet puts it in, which is what every diagram written before
    // 1.8.0 means as well. A diagram setting rather than a tool preference: it is part of how the
    // drawing is laid out, so it travels with the .dvmd file.
    legendX: null,
    legendY: null,

    showGrid: true,
    showTitleBlock: true,
    showAlternateKeys: false
  };
}

// ------------------------------------------------------------ change flow --

export function subscribe(handler) {
  subscribers.add(handler);
  return () => subscribers.delete(handler);
}

export function notify(reason) {
  invalidateTableIndex();

  for (const handler of subscribers) {
    try { handler(reason); } catch (error) { console.error('Subscriber failed', error); }
  }
}

/**
 * Counts structural changes to the document.
 *
 * The card size cache in geometry.js has to notice when a different set of relationships becomes
 * visible, because the lookup column a connector points at is drawn only while the connector is.
 * It used to ask visibleRelationships() on every measurement, which is O(relationships x tables)
 * and cost far more than the measurement it was avoiding - and the part of the answer it kept, the
 * count, could not tell two different sets of the same size apart: hide one connector and show
 * another and the card kept the rows measured for the first. A counter answers the same question
 * in one integer read and cannot collide.
 *
 * Bumped by every path that can replace or reshape the document: mutate, undo, redo and
 * setDocument. Dragging a card does not come through any of them until the pointer is released,
 * which is exactly why the size cache survives a drag.
 */
let topology = 0;

export function topologyVersion() { return topology; }

function bumpTopology() { topology = (topology + 1) >>> 0; }

/**
 * Runs a mutation as one undoable step. Pass { silent: true } for view-only changes
 * that should not land in the undo history or mark the diagram dirty.
 */
export function mutate(label, fn, options) {
  const opts = options || {};

  if (!opts.silent) {
    undoStack.push({ label, doc: clone(state.doc) });
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
    redoStack = [];
  }

  const result = fn(state.doc);

  if (!opts.silent) {
    state.doc.modifiedUtc = new Date().toISOString();
    setDirty(true);
  }

  bumpTopology();
  notify(label);
  return result;
}

export function canUndo() { return undoStack.length > 0; }
export function canRedo() { return redoStack.length > 0; }

export function undo() {
  if (!undoStack.length) return false;
  const entry = undoStack.pop();
  redoStack.push({ label: entry.label, doc: clone(state.doc) });
  state.doc = entry.doc;
  bumpTopology();
  pruneSelection();
  setDirty(true);
  notify('undo');
  return true;
}

export function redo() {
  if (!redoStack.length) return false;
  const entry = redoStack.pop();
  undoStack.push({ label: entry.label, doc: clone(state.doc) });
  state.doc = entry.doc;
  bumpTopology();
  pruneSelection();
  setDirty(true);
  notify('redo');
  return true;
}

export function resetHistory() {
  undoStack = [];
  redoStack = [];
}

export function setDocument(doc, path) {
  state.doc = doc;
  state.path = path || null;
  state.view = Object.assign({ zoom: 1, panX: 60, panY: 90 }, doc.view || {});

  // Before anything below reads a table: everything memoised against the outgoing document is now
  // about a document that is no longer here.
  bumpTopology();
  invalidateTableIndex();

  // Every route a whole document arrives by comes through here - opened, refreshed, pushed by the
  // host - and none of them goes through the editors that keep a relationship and the lookup column
  // it owns in step. This is the one place that can put them back together.
  reconcileProposedLookups();

  // Everything holding an id from the outgoing document has to go with it. A connect-mode
  // arming, a relationship filter or a path highlight left pointing at a table that no longer
  // exists is at best invisible and at worst acts on the wrong object in the new diagram.
  clearSelection();
  state.filters.tableId = null;
  notify('document-replacing');

  resetHistory();
  setDirty(false);
  notify('document');
}

let dirtyNotifier = null;
export function setDirtyNotifier(fn) { dirtyNotifier = fn; }

export function setDirty(value) {
  if (state.dirty === value) return;
  state.dirty = value;
  if (dirtyNotifier) dirtyNotifier(value, state.doc.title);
}

// --------------------------------------------------------------- lookups --

/**
 * Memoised id -> table index behind tableById.
 *
 * tableById is reached twice for every relationship on every frame - once for each end - and a
 * linear Array.find over the tables made routing O(relationships x tables). On a two-hundred-table
 * model that was the single largest cost of a redraw.
 *
 * Dropped in notify, so any mutation rebuilds it. The array identity and length are checked as
 * well, because a mutation reads tables again before it notifies: removeTable replaces the array,
 * addTablesFromMetadata pushes onto it, and neither may be answered from the index built before it.
 */
let tableIndex = null;
let tableIndexSource = null;
let tableIndexLength = -1;

function invalidateTableIndex() {
  tableIndex = null;
  tableIndexSource = null;
  tableIndexLength = -1;
}

export function tableById(id) {
  const tables = state.doc.tables;

  if (!tableIndex || tableIndexSource !== tables || tableIndexLength !== tables.length) {
    tableIndex = new Map();
    for (const table of tables) tableIndex.set(table.id, table);
    tableIndexSource = tables;
    tableIndexLength = tables.length;
  }

  return tableIndex.get(id) || null;
}
export function relationshipById(id) { return state.doc.relationships.find(r => r.id === id) || null; }
export function annotationById(id) { return state.doc.annotations.find(a => a.id === id) || null; }

export function tableByLogicalName(logicalName) {
  if (!logicalName) return null;
  const lower = String(logicalName).toLowerCase();
  return state.doc.tables.find(t =>
    t.status !== 'Proposed' && (t.logicalName || '').toLowerCase() === lower) || null;
}

/** Relationships actually drawn: included, not hidden, and with both ends on the canvas. */
export function visibleRelationships() {
  return state.doc.relationships.filter(r =>
    r.included !== false && !r.hidden && tableById(r.fromTableId) && tableById(r.toTableId));
}

export function relationshipsForTable(tableId) {
  return state.doc.relationships.filter(r => r.fromTableId === tableId || r.toTableId === tableId);
}

export function effectiveDetail(table) {
  if (table && table.collapsed) return 'TablesOnly';
  return (table && table.detailOverride) || state.doc.settings.fieldDetail;
}

// -------------------------------------------------------------- mutations --

/**
 * Adds Dataverse tables to the document. Tables already present are refreshed in place rather
 * than duplicated, so "add to current diagram" is genuinely additive.
 */
export function addTablesFromMetadata(dtos, options) {
  const opts = options || {};
  const added = [];

  for (const dto of dtos || []) {
    const existing = tableByLogicalName(dto.logicalName);
    if (existing) {
      Object.assign(existing, {
        schemaName: dto.schemaName,
        displayName: dto.displayName,
        metadataId: dto.metadataId,
        objectTypeCode: dto.objectTypeCode,
        primaryIdAttribute: dto.primaryIdAttribute,
        primaryNameAttribute: dto.primaryNameAttribute,
        isCustom: dto.isCustom,
        isManaged: dto.isManaged,
        isActivity: dto.isActivity,
        isIntersect: dto.isIntersect,
        ownershipType: dto.ownershipType,
        description: dto.description,
        alternateKeys: dto.alternateKeys || [],
        columns: mergeColumns(existing.columns, dto.columns),
        missingSinceRefresh: false
      });
      continue;
    }

    const table = {
      id: uid('t'),
      logicalName: dto.logicalName,
      schemaName: dto.schemaName,
      displayName: dto.displayName,
      status: opts.status || 'Existing',
      metadataId: dto.metadataId,
      objectTypeCode: dto.objectTypeCode,
      primaryIdAttribute: dto.primaryIdAttribute,
      primaryNameAttribute: dto.primaryNameAttribute,
      isCustom: !!dto.isCustom,
      isManaged: !!dto.isManaged,
      isActivity: !!dto.isActivity,
      isIntersect: !!dto.isIntersect,
      ownershipType: dto.ownershipType || null,
      description: dto.description,
      x: 0, y: 0,
      collapsed: false,
      detailOverride: null,
      highlight: null,
      notes: '',
      columns: (dto.columns || []).map(c => Object.assign({}, c)),
      alternateKeys: dto.alternateKeys || []
    };

    state.doc.tables.push(table);
    added.push(table);
  }

  return added;
}

function mergeColumns(previous, incoming) {
  const byName = new Map((previous || []).map(c => [(c.logicalName || c.id || '').toLowerCase(), c]));
  const proposed = (previous || []).filter(c => c.status === 'Proposed');

  // Names a proposal already claims. The real column of that name is held back rather than added
  // beside it, which is what the host does during a refresh for exactly the same reason: two rows
  // with one logical name is a card that reads as a bug, and rowCentreY anchors the connector to
  // whichever of them comes first. It is easy to reach now that a proposed relationship names its
  // lookup the way Dataverse would - `accountid` really is the name on both sides.
  //
  // The proposal is kept rather than the real column because nothing proposed is ever promoted
  // without being confirmed. Refresh offers the match; this path is not the place to decide it.
  const claimed = new Set(proposed
    .map(c => String(c.logicalName || '').toLowerCase())
    .filter(Boolean));

  const merged = (incoming || [])
    .filter(column => !claimed.has(String(column.logicalName || '').toLowerCase()))
    .map(column => {
      const before = byName.get((column.logicalName || '').toLowerCase());
      if (!before) return Object.assign({}, column);
      return Object.assign({}, column, {
        selected: before.selected !== false,
        notes: before.notes,
        status: before.status === 'Deprecated' ? 'Deprecated' : 'Existing'
      });
    });

  return merged.concat(proposed);
}

/**
 * Adds relationships whose two ends are both on the canvas. Existing entries are matched by
 * schema name so re-running discovery never duplicates a connector or loses an inclusion choice.
 */
export function addRelationshipsFromMetadata(dtos, options) {
  const opts = options || {};
  const added = [];

  for (const dto of dtos || []) {
    const from = tableByLogicalName(dto.referencedEntity);
    const to = tableByLogicalName(dto.referencingEntity);
    if (!from || !to) continue;

    const existing = state.doc.relationships.find(r =>
      r.schemaName && dto.schemaName &&
      r.schemaName.toLowerCase() === dto.schemaName.toLowerCase());

    if (existing) {
      Object.assign(existing, {
        displayName: dto.displayName,
        metadataId: dto.metadataId,
        referencedAttribute: dto.referencedAttribute,
        referencingAttribute: dto.referencingAttribute,
        intersectEntity: dto.intersectEntity,
        entity1IntersectAttribute: dto.entity1IntersectAttribute,
        entity2IntersectAttribute: dto.entity2IntersectAttribute,
        isCustom: dto.isCustom,
        isManaged: dto.isManaged,
        isHierarchical: dto.isHierarchical,
        isPolymorphic: dto.isPolymorphic,
        lookupTargets: dto.lookupTargets || [],
        cascade: dto.cascade,
        fromTableId: from.id,
        toTableId: to.id,
        missingSinceRefresh: false
      });
      continue;
    }

    // A proposed relationship already describing this one. Matched on the two ends, the cardinality
    // and the lookup column rather than on the schema name, because a proposal's schema name is
    // whatever the user typed and almost never what the developer used. Checked after the schema
    // name, so a real relationship the diagram already carries is still refreshed.
    //
    // Adding the real one beside the proposal drew two connectors between the same pair of cards,
    // one solid and one dashed, with nothing on screen saying they were the same relationship - and
    // since the proposal owns a lookup column of that name, both anchored to the same row. The
    // proposal is left standing and Refresh is what offers to promote it, the same as for a column.
    const alreadyProposed = state.doc.relationships.some(r =>
      r.status === 'Proposed' &&
      r.fromTableId === from.id && r.toTableId === to.id &&
      (r.kind === 'ManyToMany') === (dto.kind === 'ManyToMany') &&
      String(r.referencingAttribute || '').toLowerCase() ===
        String(dto.referencingAttribute || '').toLowerCase());

    if (alreadyProposed) continue;

    const relationship = {
      id: uid('r'),
      schemaName: dto.schemaName,
      displayName: dto.displayName,
      kind: dto.kind === 'ManyToMany' ? 'ManyToMany' : 'OneToMany',
      status: 'Existing',
      fromTableId: from.id,
      toTableId: to.id,
      metadataId: dto.metadataId,
      referencedEntity: dto.referencedEntity,
      referencingEntity: dto.referencingEntity,
      referencedAttribute: dto.referencedAttribute,
      referencingAttribute: dto.referencingAttribute,
      intersectEntity: dto.intersectEntity,
      entity1IntersectAttribute: dto.entity1IntersectAttribute,
      entity2IntersectAttribute: dto.entity2IntersectAttribute,
      isCustom: !!dto.isCustom,
      isManaged: !!dto.isManaged,
      isHierarchical: !!dto.isHierarchical,
      isPolymorphic: !!dto.isPolymorphic,
      lookupTargets: dto.lookupTargets || [],
      cascade: dto.cascade || null,
      // Hide is the only visibility control since 1.7.0, when Exclude was removed for duplicating
      // it. `included` is still written so a file opened by an older build behaves the same, but
      // it is always true here and the caller says what it wants through `hidden`.
      included: true,
      hidden: opts.hidden === true,
      highlight: null,
      notes: '',
      waypoints: []
    };

    state.doc.relationships.push(relationship);
    added.push(relationship);
  }

  return added;
}

/** Removes a table from the diagram. This never touches Dataverse. */
export function removeTable(tableId) {
  const orphaned = state.doc.relationships.filter(
    r => r.fromTableId === tableId || r.toTableId === tableId);

  state.doc.tables = state.doc.tables.filter(t => t.id !== tableId);
  state.doc.relationships = state.doc.relationships.filter(
    r => r.fromTableId !== tableId && r.toTableId !== tableId);

  // A proposed relationship owns the lookup column it implies, and that column sits on the table
  // at the many end - which may well be a table that is staying. Dropping the connector without
  // dropping the column it drew would leave a lookup on a card pointing at nothing.
  for (const relationship of orphaned) removeRelationshipColumns(relationship.id);

  // Annotations attached to the relationships that went with the table are detached too, not just
  // the ones attached to the table itself. removeRelationship has always done this for the one id
  // it is given; a connector cascaded away from here left a sticky note holding a dead
  // attachedToId, which is then written to the .dvmd file and reopened pointing at nothing.
  const gone = new Set(orphaned.map(r => r.id));
  gone.add(tableId);

  state.doc.annotations.forEach(a => { if (gone.has(a.attachedToId)) a.attachedToId = null; });
  state.selection.tables.delete(tableId);
}

export function removeRelationship(relationshipId) {
  state.doc.relationships = state.doc.relationships.filter(r => r.id !== relationshipId);
  removeRelationshipColumns(relationshipId);
  state.doc.annotations.forEach(a => { if (a.attachedToId === relationshipId) a.attachedToId = null; });
  state.selection.relationships.delete(relationshipId);
}

// ------------------------------------------------- proposed lookup columns --

/**
 * Removes the proposed lookup column a proposed relationship created.
 *
 * Only ever a column still marked Proposed. If a refresh has matched it against a real one and the
 * user has confirmed the promotion, the column is Dataverse's now, and deleting a connector from a
 * diagram must not delete a column that actually exists.
 */
export function removeRelationshipColumns(relationshipId, exceptTableId) {
  if (!relationshipId) return;

  for (const table of state.doc.tables) {
    if (exceptTableId && table.id === exceptTableId) continue;

    table.columns = (table.columns || []).filter(column =>
      !(column.fromRelationshipId === relationshipId && column.status === 'Proposed'));

    // A settled column stays - it says the lookup exists, and removing something from a diagram
    // never removes something from Dataverse - but nothing owns it once the relationship has gone,
    // so the link is dropped and the ordinary column rules apply to it again.
    for (const column of table.columns) {
      if (column.fromRelationshipId === relationshipId) column.fromRelationshipId = null;
    }
  }
}

/**
 * Settles a relationship's lookup column when the relationship stops being a proposal.
 *
 * The column stays on the card and takes the relationship's new status - existing, or deprecated
 * and struck through. Deleting it instead would take a lookup off a card at the moment somebody
 * asserted the lookup is there.
 *
 * The `fromRelationshipId` link is deliberately kept. Clearing it looked tidier and was wrong: a
 * relationship marked existing and then proposed again could not find its own column any more, so
 * it left the old one behind as an Existing row under a Proposed connector and made a second one.
 * The link is what lets the round trip work; what changes with the status is which rules apply to
 * the column, and those are read from `status`, not from the link.
 */
export function settleRelationshipColumns(relationshipId, status) {
  if (!relationshipId) return;

  const settled = status === 'Deprecated' ? 'Deprecated' : 'Existing';

  for (const table of state.doc.tables) {
    for (const column of table.columns || []) {
      if (column.fromRelationshipId !== relationshipId) continue;
      column.status = settled;
    }
  }
}

/**
 * Brings every relationship-owned lookup column into line with the relationship that owns it.
 *
 * Run whenever a whole document arrives - opened from disk, refreshed against Dataverse, or pushed
 * by the host - because none of those paths goes through the canvas editors that normally keep the
 * two in step. Two states have to be repaired:
 *
 * - A column owned by a relationship that is no longer proposed. The host promotes a matched
 *   proposed relationship to Existing during a refresh and does not touch its column, which left a
 *   proposed lookup row belonging to a relationship the editor refuses to open: the column could
 *   not be edited, and it could not be removed either.
 * - A column owned by a relationship that is not in the document at all. DiagramFile drops a
 *   relationship whose end tables have gone, and a hand-edited file can lose one any number of
 *   ways. The column is then a permanent orphan for the same reason.
 */
export function reconcileProposedLookups() {
  const statusById = new Map();
  for (const relationship of state.doc.relationships) statusById.set(relationship.id, relationship.status);

  for (const table of state.doc.tables) {
    for (const column of table.columns || []) {
      if (!column.fromRelationshipId) continue;

      if (!statusById.has(column.fromRelationshipId)) {
        // Nothing owns it any more, so it becomes an ordinary column of whatever status it has.
        column.fromRelationshipId = null;
        continue;
      }

      const status = statusById.get(column.fromRelationshipId);
      if (status !== 'Proposed' && column.status === 'Proposed') {
        column.status = status === 'Deprecated' ? 'Deprecated' : 'Existing';
      }
    }
  }
}

/**
 * Puts the lookup column a proposed 1:N relationship implies onto the table at its many end.
 *
 * A relationship in Dataverse *is* a lookup column plus its cascade rules, so proposing one and
 * then having to hand-draw the column that comes with it was asking the user to say the same thing
 * twice - and the two could disagree. The column is owned by the relationship: it carries
 * `fromRelationshipId`, it is renamed when the lookup name changes, it moves when the many end
 * changes, and it goes when the relationship goes.
 *
 * It also gives the connector something to point at. routeRelationship anchors each end to the row
 * showing the attribute it uses, so once the column exists the line lands on the lookup field
 * rather than on the middle of the card header.
 *
 * Returns the column, or null when the relationship implies none (many-to-many has an intersect
 * table rather than a lookup, and a relationship that is not proposed describes what Dataverse
 * already has).
 */
export function syncProposedLookupColumn(relationship) {
  if (!relationship) return null;

  // The relationship is no longer a proposal: the user has marked it as existing, or as being
  // retired. The column it created is real too, so it is handed over rather than deleted - taking
  // a lookup off a card at the moment somebody asserts the lookup is there would be exactly wrong,
  // and while it was still owned by a non-proposed relationship it could be neither edited nor
  // removed by any route the UI offers.
  if (relationship.status !== 'Proposed') {
    settleRelationshipColumns(relationship.id, relationship.status);
    return null;
  }

  const many = relationship.kind !== 'ManyToMany' ? tableById(relationship.toTableId) : null;
  const one = tableById(relationship.fromTableId);

  if (!many || !one) {
    removeRelationshipColumns(relationship.id);
    return null;
  }

  // Anything this relationship put on another table - because the user has since changed which
  // table is at the many end - goes first.
  removeRelationshipColumns(relationship.id, many.id);

  const name = lookupColumnName(relationship, one);
  relationship.referencingAttribute = name;

  // The one end is drawn from its primary key, which is what the lookup would actually hold.
  relationship.referencedAttribute = referencedKeyName(relationship, one);

  const columns = many.columns || (many.columns = []);
  const owned = columns.find(entry => entry.fromRelationshipId === relationship.id);

  // Something else on this card already carries that name: a real column read from Dataverse, one
  // the user proposed by hand, or one belonging to another proposed relationship. Whichever it is,
  // that column is the one the connector should point at. Writing the name onto a second row would
  // draw the same field twice - and rowCentreY matches the first by name, so the line would land
  // on one of them while the other sat below it - and taking the column over would silently rewire
  // whatever already owned it.
  const sameName = columns.find(entry =>
    entry !== owned && String(entry.logicalName || '').toLowerCase() === name.toLowerCase());

  if (sameName) {
    if (owned) removeRelationshipColumns(relationship.id);
    return sameName;
  }

  let column = owned;

  if (!column) {
    column = { id: uid('c'), notes: '' };
    columns.push(column);
  }

  Object.assign(column, {
    fromRelationshipId: relationship.id,
    displayName: column.displayName ||
      (one.displayName || one.logicalName || one.schemaName || 'Lookup'),
    logicalName: name,
    typeName: 'Lookup',
    attributeType: 'Lookup',
    isLookup: true,
    isPrimaryId: false,
    isPrimaryName: false,
    isRequired: !!column.isRequired,
    status: 'Proposed',
    selected: true,
    targets: [one.logicalName || one.schemaName || one.displayName].filter(Boolean)
  });

  return column;
}

/**
 * The column at the one end that the connector should point at - the key the lookup holds.
 *
 * Resolved from the table on every sync rather than written once and left, which is what the old
 * `if (!relationship.referencedAttribute && one.primaryIdAttribute)` did. That guard failed in both
 * directions. It never filled the name in for a table with no `primaryIdAttribute` - which is every
 * table proposed on the canvas before its primary key column is named, and every external system -
 * so the line met the middle of the header instead of a row. And once it *had* filled it in,
 * nothing ever corrected it: swap the one end of a proposed relationship from Account to Lead and
 * `accountid` stayed, naming a column the new card has never heard of, which lands on the header
 * again.
 *
 * Written to on proposed relationships only. Nothing in the UI edits `referencedAttribute` by hand,
 * and syncProposedLookupColumn returns before this line for anything that is not a proposal, so a
 * name that came from Dataverse with a real relationship is never touched. A name already on a
 * proposal is still kept when the one end genuinely has a column of that name.
 */
function referencedKeyName(relationship, one) {
  const columns = one.columns || [];
  const named = value => columns.some(column =>
    String(column.logicalName || column.schemaName || '').toLowerCase() === String(value).toLowerCase());

  const current = String(relationship.referencedAttribute || '').trim();
  if (current && named(current)) return current;

  if (one.primaryIdAttribute) return one.primaryIdAttribute;

  // A table proposed on the canvas can claim a primary key on the column without the table-level
  // name having caught up - the column editor and the table editor set both, but the two are
  // written by different paths and a relationship can be proposed between them.
  const key = columns.find(column => column.isPrimaryId);
  return key ? (key.logicalName || key.schemaName || '') : '';
}

/**
 * The lookup column name a proposed relationship uses, falling back to a name from the one end.
 *
 * The underscore is kept. Stripping every character that is not a letter or a digit turned the
 * one end's own logical name into something Dataverse would never call a column: a lookup to
 * `dev_project` came out as `devprojectid` rather than `dev_projectid`, so the name the editor
 * offered - and the name that then went onto the card, into the connector anchor and into every
 * export - dropped the publisher prefix's separator. Everything else that is not a letter, a
 * digit or an underscore still goes, because the fallback source can be a display name with
 * spaces and punctuation in it.
 */
export function lookupColumnName(relationship, oneEnd) {
  const chosen = String((relationship && relationship.referencingAttribute) || '').trim();
  if (chosen) return chosen;

  const source = oneEnd &&
    (oneEnd.logicalName || oneEnd.schemaName || oneEnd.displayName || 'related');

  return String(source || 'related').toLowerCase().replace(/[^a-z0-9_]+/g, '') + 'id';
}

// -------------------------------------------------------------- annotations --

/** Sticky notes, plain text boxes and arrows are all annotations, told apart by `kind`. */
export const ANNOTATION_KINDS = ['note', 'text', 'arrow'];

/**
 * The side of a new sticky note, and the size a note with no size of its own is drawn at.
 *
 * One number, imported by geometry.js and render.js, because a default that lived separately in
 * the measurer and the renderer is exactly how the two drift apart. The C# exporters carry the
 * same number in ExportRowBuilder.AnnotationRect and say so.
 */
export const NOTE_DEFAULT_SIZE = 140;

/** Point size of a new sticky note's text, which is bold. */
export const NOTE_DEFAULT_FONT_SIZE = 14;

/**
 * Whether an annotation is drawn behind the model - the table cards and the relationship lines
 * both - rather than on top of it.
 *
 * Absent means in front, which is what a new annotation is and what every file written before
 * 1.9.0 now means. Note that this *changes* how such a file draws: every annotation used to be
 * painted below the cards, because the annotation layer sat under the table layer with no way to
 * say otherwise - which is exactly the complaint the property exists to answer. A note the user
 * wants tucked under a card is one tick away.
 *
 * As of 1.10.0 "behind" means behind the connectors as well. It used to mean only "under the
 * cards", so a note sent behind still lay across every relationship line running under it, which
 * is not what anyone reading the word expects - and both picture exporters had written a behind
 * annotation below the lines from the day the property was added, so the canvas was the odd one
 * out rather than the standard.
 */
export function annotationBehind(annotation) {
  return !!(annotation && annotation.behind);
}

/**
 * Annotations in the order they should be painted, whichever layer they end up in.
 *
 * Sticky notes first, then text boxes and arrows. A note is opaque paper and the other two are
 * ink on the canvas: a label or an arrow that lands on a note has to be readable, and it is the
 * note that has the area to hide things with. Within each of those two groups the document order
 * is kept, so the ordinary "last one placed wins" still holds between two notes.
 *
 * A stable sort, which every runtime this can meet has been required to provide since ES2019 -
 * and the shim in the verify suite uses the platform's own Array.prototype.sort.
 */
export function annotationPaintOrder(annotations) {
  return (annotations || []).slice().sort((a, b) =>
    (annotationKind(a) === 'note' ? 0 : 1) - (annotationKind(b) === 'note' ? 0 : 1));
}

/**
 * The kind of an annotation, defaulting to a sticky note.
 *
 * Every annotation written before 1.6.0 has no `kind` at all, and every one of them was a note, so
 * the default is not arbitrary - it is what those files mean.
 */
export function annotationKind(annotation) {
  const kind = annotation && annotation.kind;
  return ANNOTATION_KINDS.includes(kind) ? kind : 'note';
}

/** A new annotation of the given kind, positioned at a world point. */
export function newAnnotation(kind, point, options) {
  const opts = options || {};
  const at = point || { x: 0, y: 0 };

  const base = {
    id: uid('n'),
    kind: ANNOTATION_KINDS.includes(kind) ? kind : 'note',
    text: '',
    x: at.x,
    y: at.y,
    fontSize: 12,
    bold: false,

    // In front of the tables. Written onto the annotation rather than left absent so the inspector
    // and the context menu have something to read back, and so the value in the file says what the
    // drawing does rather than relying on a default two runtimes have to agree about.
    behind: false,
    attachedToId: opts.attachedToId || null
  };

  if (base.kind === 'arrow') {
    return Object.assign(base, {
      // Stored as a vector rather than a second absolute point, so moving the arrow is the same
      // one-line move every other annotation gets rather than a special case.
      dx: opts.dx === undefined ? 160 : opts.dx,
      dy: opts.dy === undefined ? 0 : opts.dy,
      width: 0,
      height: 0,
      ink: opts.ink || '#c0392f',
      attachedToId: null
    });
  }

  if (base.kind === 'text') {
    return Object.assign(base, {
      width: 220,
      height: 40,
      fontSize: 14,
      ink: opts.ink || null,
      background: null,
      border: null
    });
  }

  // A new sticky note is square - a piece of paper on the canvas rather than a text field - but
  // only to start with. 1.8.0 held it square with the grip and 1.9.0 brought the free
  // resize back: a note stretched wide is a banner across a diagram, which is a fair thing to
  // want. This is a starting size, not a rule.
  //
  // The size and the text style are written onto the note rather than left to the renderer's
  // fallback, because the inspector edits both and a note that reported one size while being
  // drawn at another would be the same trap the annotationRect fallback exists to avoid.
  return Object.assign(base, {
    width: NOTE_DEFAULT_SIZE,
    height: NOTE_DEFAULT_SIZE,
    fontSize: NOTE_DEFAULT_FONT_SIZE,
    bold: true,
    background: '#fff8e1',
    border: '#e8d9a8'
  });
}

export function removeAnnotation(annotationId) {
  state.doc.annotations = state.doc.annotations.filter(a => a.id !== annotationId);
  state.selection.annotations.delete(annotationId);
}

// -------------------------------------------------------------- selection --

export function clearSelection() {
  state.selection.tables.clear();
  state.selection.relationships.clear();
  state.selection.annotations.clear();
  state.highlightPath = null;
}

export function selectOnly(kind, id) {
  clearSelection();
  if (id) state.selection[kind].add(id);
}

export function toggleSelection(kind, id) {
  const set = state.selection[kind];
  if (set.has(id)) set.delete(id);
  else set.add(id);
}

export function isSelected(kind, id) { return state.selection[kind].has(id); }

export function selectionCount() {
  return state.selection.tables.size + state.selection.relationships.size + state.selection.annotations.size;
}

function pruneSelection() {
  for (const id of Array.from(state.selection.tables)) if (!tableById(id)) state.selection.tables.delete(id);
  for (const id of Array.from(state.selection.relationships)) if (!relationshipById(id)) state.selection.relationships.delete(id);
  for (const id of Array.from(state.selection.annotations)) if (!annotationById(id)) state.selection.annotations.delete(id);
}

/** Tables and relationships one hop from the given table, for the "highlight connections" view. */
export function neighbourhood(tableId) {
  const tables = new Set([tableId]);
  const relationships = new Set();

  for (const relationship of visibleRelationships()) {
    if (relationship.fromTableId === tableId) { tables.add(relationship.toTableId); relationships.add(relationship.id); }
    else if (relationship.toTableId === tableId) { tables.add(relationship.fromTableId); relationships.add(relationship.id); }
  }

  return { tables, relationships };
}
