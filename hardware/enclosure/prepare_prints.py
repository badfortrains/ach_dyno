"""Orient Fusion STL exports in millimetres and check closed, connected meshes."""
from pathlib import Path
import struct, collections, json
ROOT=Path(__file__).resolve().parent

def process(name):
 data=(ROOT/(name+'_raw.stl')).read_bytes()
 n=struct.unpack_from('<I',data,80)[0]
 assert len(data)==84+50*n,'Expected binary STL'
 out=bytearray(data[:84]); edges=collections.Counter(); adj=collections.defaultdict(set); vertices=[]; volume=0
 def move(p):
  x,y,z=p
  return (x-10,y-10,z) if name=='base' else (x-10,75-y,34-z)
 for i in range(n):
  vals=struct.unpack_from('<12fH',data,84+i*50)
  normal=vals[:3] if name=='base' else (vals[0],-vals[1],-vals[2])
  pts=[move(vals[j:j+3]) for j in (3,6,9)]; vertices.extend(pts)
  keys=[tuple(round(x,4) for x in p) for p in pts]
  for a,b in zip(keys,keys[1:]+keys[:1]):
   edges[tuple(sorted((a,b)))]+=1; adj[a].add(b); adj[b].add(a)
  a,b,c=pts
  volume+=(a[0]*(b[1]*c[2]-b[2]*c[1])+a[1]*(b[2]*c[0]-b[0]*c[2])+a[2]*(b[0]*c[1]-b[1]*c[0]))/6
  out.extend(struct.pack('<12fH',*normal,*pts[0],*pts[1],*pts[2],vals[-1]))
 assert all(v==2 for v in edges.values()),'Non-manifold/open edges'
 remaining=set(adj); components=0
 while remaining:
  components+=1; todo=[remaining.pop()]
  while todo:
   for v in adj[todo.pop()]:
    if v in remaining: remaining.remove(v); todo.append(v)
 assert components==1,'Disconnected mesh'
 assert volume>0,'Inverted mesh'
 bounds=[[min(p[k] for p in vertices),max(p[k] for p in vertices)] for k in range(3)]
 assert abs(bounds[2][0])<1e-4
 (ROOT/(name+'.stl')).write_bytes(out)
 return {'part':name,'triangles':n,'closed_manifold':True,'connected_components':components,'volume_mm3':volume,'bounds_mm':bounds}
if __name__=='__main__':
 report=[process(n) for n in ('base','lid')]
 (ROOT/'mesh_validation.json').write_text(json.dumps(report,indent=2)+'\n')
 print(json.dumps(report,indent=2))
