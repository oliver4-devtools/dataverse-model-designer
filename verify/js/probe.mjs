import { installDom } from './dom-shim.mjs';
installDom();
const js = '../../src/Oliver4.DataverseModelDesigner/Web/js/';
const state = await import(js + 'state.js');
const geometry = await import(js + 'geometry.js');

const col = (id, ln, dn, extra) => Object.assign({ id, logicalName: ln, schemaName: ln, displayName: dn,
  typeName: 'Text', isPrimaryId:false, isPrimaryName:false, isLookup:false, targets:[], selected:true, status:'Existing' }, extra||{});
const card = (id, ln, dn, cols) => ({ id, logicalName: ln, schemaName: dn, displayName: dn, status:'Existing',
  x:0,y:0,collapsed:false,detailOverride:null,highlight:null,notes:'',alternateKeys:[],columnOrder:[],
  primaryIdAttribute: ln+'id', primaryNameAttribute:'name',
  columns:[col(id+'pk', ln+'id','Id',{isPrimaryId:true}), col(id+'nm','name','Name',{isPrimaryName:true}), ...(cols||[])]});

const doc = state.newDocument('probe');
state.setDocument(doc, null);
const d = state.state.doc;
const a = card('A','account','Account'); const b = card('B','contact','Contact',[col('Bfk','parentcustomerid','Customer',{isLookup:true,targets:['account']})]);
a.x=0;a.y=0;b.x=600;b.y=220;
d.tables.push(a,b);
d.settings.fieldDetail='RelationshipFields';
const rel = { id:'r', schemaName:'r', kind:'OneToMany', status:'Existing', fromTableId:a.id, toTableId:b.id,
  referencedAttribute:'accountid', referencingAttribute:'parentcustomerid', included:true, hidden:false, waypoints:[], lookupTargets:[] };
d.relationships.push(rel);
geometry.invalidateSizes();
const base = geometry.routeRelationship(rel,0,1);
console.log('start', JSON.stringify(base.start), 'end', JSON.stringify(base.end));
console.log('auto', base.points.map(p=>p.x+','+p.y).join(' '));

const tries = [
  [{x:300,y:40},{x:300,y:40}],
  [{x:300,y:100},{x:400,y:100},{x:300,y:100}],
  [{x:300,y:100},{x:300,y:300},{x:300,y:100}],
  [{x:250,y:40},{x:450,y:300},{x:250,y:40}],
];
for (const w of tries) {
  rel.waypoints = w;
  const r = geometry.routeRelationship(rel,0,1);
  const dup = r.corners.filter((c,i)=>r.corners.some((o,j)=>j!==i && Math.abs(o.x-c.x)<0.01 && Math.abs(o.y-c.y)<0.01));
  console.log(JSON.stringify(w), '->', r.points.map(p=>p.x+','+p.y).join(' '), '| dup', dup.length);
}
