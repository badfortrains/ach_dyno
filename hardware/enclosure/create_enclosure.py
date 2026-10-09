"""Run in Fusion via Scripts or MCP. Dimensions in mm; creates a NEW document."""
import adsk.core as C, adsk.fusion as F
import json, os
OUT = '/Users/suzanna/Documents/code/ach_dyno/hardware/enclosure'

def run(_context: str):
    app=C.Application.get()
    doc=app.documents.add(C.DocumentTypes.FusionDesignDocumentType)
    doc.name='Calf Dyno - snap enclosure v1'
    d=F.Design.cast(app.activeProduct)
    d.designType=F.DesignTypes.ParametricDesignType
    d.unitsManager.distanceDisplayUnits=F.DistanceUnits.MillimeterDistanceUnits
    root=d.rootComponent
    specs=[
      ('inside_length','86 mm','Clear cavity length'),('inside_width','61 mm','Clear cavity width'),
      ('inside_height','30 mm','Floor to lid underside; clips occupy side margins'),
      ('wall','2 mm','Wall thickness'),('floor_thickness','2 mm','Floor thickness'),('lid_thickness','2 mm','Lid plate'),
      ('fit_clearance','0.3 mm','Per-side clearance of lid guides and clip stems'),
      ('usb_width','16 mm','Opening for plug overmould'),('usb_height','10 mm','USB opening height'),
      ('usb_bottom','4 mm','USB opening bottom above outside base bottom'),
      ('usb_y','outer_width / 2','USB port lateral center'),
      ('cable_width','7 mm','Drop-in cable notch width'),('cable_depth','7 mm','Depth below lid seam'),
      ('snap_length','14 mm','Flexible clip length'),('snap_thickness','1.2 mm','Flexible clip thickness'),
      ('snap_width','8 mm','Clip width'),('snap_projection','0.55 mm','Hook projection beyond stem'),
      ('hook_height','2 mm','Hook height'),('corner_radius','2 mm','Outside vertical corners'),
      ('outer_length','inside_length + 2 * wall','Derived exterior length'),
      ('outer_width','inside_width + 2 * wall','Derived exterior width'),
      ('base_height','inside_height + floor_thickness','Derived base height')]
    # Add dependent parameters after their prerequisites.
    order=[s for s in specs if s[0]!='usb_y']
    for n,e,c in order: d.userParameters.add(n,C.ValueInput.createByString(e),'mm',c)
    d.userParameters.add('usb_y',C.ValueInput.createByString('outer_width / 2'),'mm','USB opening lateral center')
    def v(e): return C.ValueInput.createByString(e)
    def val(e): return d.unitsManager.evaluateExpression(e,'mm')
    def pt(x,y,z=0): return C.Point3D.create(x,y,z)
    def component(name):
        occ=root.occurrences.addNewComponent(C.Matrix3D.create()); occ.component.name=name
        return occ,occ.component
    def rect(comp,name,x,y,w,h,z,depth,op):
        sk=comp.sketches.add(comp.xYConstructionPlane); sk.name=name+' profile'
        a,b,c,e=map(val,(x,y,w,h))
        lines=sk.sketchCurves.sketchLines.addTwoPointRectangle(pt(a,b),pt(a+c,b+e))
        p=lines.item(0).startSketchPoint
        # Rectangle starts at supplied lower left; all model coordinates are positive.
        dims=sk.sketchDimensions
        H=F.DimensionOrientations.HorizontalDimensionOrientation
        V=F.DimensionOrientations.VerticalDimensionOrientation
        dims.addDistanceDimension(sk.originPoint,p,H,pt(a/2,b-.3)).parameter.expression=x
        dims.addDistanceDimension(sk.originPoint,p,V,pt(a-.3,b/2)).parameter.expression=y
        dims.addDistanceDimension(lines.item(0).startSketchPoint,lines.item(0).endSketchPoint,H,pt(a+c/2,b-.2)).parameter.expression=w
        dims.addDistanceDimension(lines.item(1).startSketchPoint,lines.item(1).endSketchPoint,V,pt(a+c+.2,b+e/2)).parameter.expression=h
        inp=comp.features.extrudeFeatures.createInput(sk.profiles.item(0),op)
        inp.startExtent=F.OffsetStartDefinition.create(v(z))
        inp.setOneSideExtent(F.DistanceExtentDefinition.create(v(depth)),F.ExtentDirections.PositiveExtentDirection)
        feat=comp.features.extrudeFeatures.add(inp); feat.name=name
        sk.isVisible=False
        return feat
    def edges_where(body,fn):
        coll=C.ObjectCollection.create()
        for edge in body.edges:
            if edge.startVertex and edge.endVertex and fn(edge.startVertex.geometry,edge.endVertex.geometry): coll.add(edge)
        return coll
    def fillet(comp,edges,r,name):
        if edges.count==0: raise RuntimeError('No edges for '+name)
        fi=comp.features.filletFeatures.createInput(); fi.edgeSetInputs.addConstantRadiusEdgeSet(edges,v(r),False)
        f=comp.features.filletFeatures.add(fi); f.name=name
    def close(a,b): return abs(a-b)<1e-5
    NEW=F.FeatureOperations.NewBodyFeatureOperation; JOIN=F.FeatureOperations.JoinFeatureOperation; CUT=F.FeatureOperations.CutFeatureOperation
    bo,base=component('Base - print floor down')
    body=rect(base,'Outer shell blank','10 mm','10 mm','outer_length','outer_width','0 mm','base_height',NEW).bodies.item(0)
    body.name='Enclosure base'
    vertical=edges_where(body,lambda a,b: close(a.x,b.x) and close(a.y,b.y) and abs(a.z-b.z)>1)
    fillet(base,vertical,'corner_radius','Rounded outside corners')
    rect(base,'Electronics cavity','10 mm + wall','10 mm + wall','inside_length','inside_width','floor_thickness','inside_height + 1 mm',CUT)
    rect(base,'USB-C plug access','9 mm','10 mm + usb_y - usb_width / 2','wall + 2 mm','usb_width','usb_bottom','usb_height',CUT)
    rect(base,'Drop-in load-cell cable notch','10 mm + outer_length - wall - 1 mm','10 mm + outer_width / 2 - cable_width / 2','wall + 2 mm','cable_width','base_height - cable_depth','cable_depth + 1 mm',CUT)
    # Round the bottom edges of the open notch, creating a U-shaped cable seat.
    cy=val('10 mm + outer_width / 2'); cw=val('cable_width'); zz=val('base_height - cable_depth')
    ne=edges_where(body,lambda a,b: close(a.z,zz) and close(b.z,zz) and close(a.y,b.y) and (close(a.y,cy-cw/2) or close(a.y,cy+cw/2)) and abs(a.x-b.x)>.1)
    fillet(base,ne,'cable_width / 2 - 0.2 mm','Rounded cable seat')
    for xpos in ['outer_length * 0.23','outer_length * 0.77']:
        for side,y in [('front','9 mm'),('back','10 mm + outer_width - wall - 1 mm')]:
            rect(base,'Snap window '+side+' '+xpos,'10 mm + '+xpos+' - snap_width / 2 - fit_clearance',y,'snap_width + 2 * fit_clearance','wall + 2 mm','base_height - snap_length - fit_clearance','hook_height + 2 * fit_clearance',CUT)
    # Low internal bridge for a small zip tie; the cable can be secured without desoldering.
    rect(base,'Cable tie anchor','10 mm + outer_length - wall - 14 mm','10 mm + outer_width / 2 - 5 mm','8 mm','10 mm','floor_thickness','5 mm',JOIN)
    rect(base,'Cable tie tunnel','10 mm + outer_length - wall - 15 mm','10 mm + outer_width / 2 - 2 mm','10 mm','4 mm','floor_thickness + 1 mm','2 mm',CUT)
    lo,lid=component('Lid - print outside face down')
    lb=rect(lid,'Lid plate','10 mm','10 mm','outer_length','outer_width','base_height','lid_thickness',NEW).bodies.item(0); lb.name='Snap lid'
    le=edges_where(lb,lambda a,b: close(a.x,b.x) and close(a.y,b.y) and abs(a.z-b.z)>.1)
    fillet(lid,le,'corner_radius','Lid outside corners')
    # Eight short guide ribs, restricted to corners so they do not block cable or USB openings.
    for end,x in [('left','10 mm + wall + fit_clearance'),('right','10 mm + outer_length - wall - fit_clearance - 7 mm')]:
        for side,y in [('front','10 mm + wall + fit_clearance'),('back','10 mm + outer_width - wall - fit_clearance - 1.2 mm')]:
            rect(lid,'Guide '+end+' '+side,x,y,'7 mm','1.2 mm','base_height - 3 mm','3 mm',JOIN)
    for end,x in [('left','10 mm + wall + fit_clearance'),('right','10 mm + outer_length - wall - fit_clearance - 1.2 mm')]:
        for side,y in [('front','10 mm + wall + fit_clearance'),('back','10 mm + outer_width - wall - fit_clearance - 7 mm')]:
            rect(lid,'End guide '+end+' '+side,x,y,'1.2 mm','7 mm','base_height - 3 mm','3 mm',JOIN)
    for i,xpos in enumerate(['outer_length * 0.23','outer_length * 0.77']):
        for side in ['front','back']:
            front=side=='front'
            y='10 mm + wall + fit_clearance' if front else '10 mm + outer_width - wall - fit_clearance - snap_thickness'
            rect(lid,'Flexible snap '+side+str(i),'10 mm + '+xpos+' - snap_width / 2',y,'snap_width','snap_thickness','base_height - snap_length','snap_length',JOIN)
            hy='10 mm + wall + fit_clearance - snap_projection' if front else y
            rect(lid,'Snap hook '+side+str(i),'10 mm + '+xpos+' - snap_width / 2',hy,'snap_width','snap_thickness + snap_projection','base_height - snap_length','hook_height',JOIN)
            ey=val(hy) if front else val(y+' + snap_thickness + snap_projection')
            ez=val('base_height - snap_length'); ex=val('10 mm + '+xpos)
            ed=edges_where(lb,lambda a,b: close(a.y,ey) and close(b.y,ey) and close(a.z,ez) and close(b.z,ez) and abs((a.x+b.x)/2-ex)<.01)
            ci=lid.features.chamferFeatures.createInput2(); ci.chamferEdgeSets.addEqualDistanceChamferEdgeSet(ed,v('snap_projection'),False)
            lid.features.chamferFeatures.add(ci).name='Insertion ramp '+side+str(i)
    # Reinforce the four cantilever roots on their inner sides.
    H=d.userParameters.itemByName('base_height').value
    W=d.userParameters.itemByName('outer_width').value
    L=d.userParameters.itemByName('outer_length').value
    wall=d.userParameters.itemByName('wall').value
    gap=d.userParameters.itemByName('fit_clearance').value
    t=d.userParameters.itemByName('snap_thickness').value
    es=C.ObjectCollection.create()
    for edge in lb.edges:
     if not edge.startVertex or not edge.endVertex: continue
     a=edge.startVertex.geometry; b=edge.endVertex.geometry
     if abs(a.z-H)<1e-5 and abs(b.z-H)<1e-5 and abs(a.y-b.y)<1e-5:
      if min(abs(a.y-(1+wall+gap+t)),abs(a.y-(1+W-wall-gap-t)))<1e-5:
       if min(abs((a.x+b.x)/2-(1+L*.23)),abs((a.x+b.x)/2-(1+L*.77)))<1e-5: es.add(edge)
    assert es.count==4,es.count
    fi=lid.features.filletFeatures.createInput(); fi.edgeSetInputs.addConstantRadiusEdgeSet(es,C.ValueInput.createByString('0.8 mm'),False)
    lid.features.filletFeatures.add(fi).name='Rounded snap roots'
    # Store practical assembly notes with the model.
    root.attributes.add('enclosure','notes','Prototype: verify hardware dimensions. Flat floor accepts insulating foam tape. Position D1 USB against opening. Drop soldered cable into rim notch, secure to internal tie bridge. Print lid outside face down. Release snaps through side windows.')
    d.computeAll()
    problems=[]
    for i in range(d.timeline.count):
        t=d.timeline.item(i)
        if t.healthState != F.FeatureHealthStates.HealthyFeatureHealthState: problems.append([t.name,t.errorOrWarningMessage])
    print(json.dumps({'created':doc.name,'base_bodies':base.bRepBodies.count,'lid_bodies':lid.bRepBodies.count,'timeline_items':d.timeline.count,'warnings':problems}))
    app.activeViewport.fit()
