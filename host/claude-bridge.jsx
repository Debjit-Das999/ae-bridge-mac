// claude-bridge.jsx
//
// Drop this file into After Effects' Scripts/Startup folder (see install.sh).
// It opens a local TCP listener using ExtendScript's native Socket object
// (Socket.listen/poll — documented server mode, no CEP required) and dispatches
// a fixed table of named operations against the AE scripting DOM.
//
// Prerequisite: AE Preferences > General/Scripting & Expressions >
// "Allow Scripts to Write Files and Access Network" must be enabled, or
// listener.listen() will throw.

$.global.__claudeBridge = $.global.__claudeBridge || (function () {

    var PORT = 41890;
    var POLL_MS = 25;
    // Don't start polling until AE has had time to finish launching/opening
    // its project; a scheduled task that fires while a startup modal is up
    // gets blocked by AE.
    var START_DELAY_MS = 12000;
    // Keep this short: a blocking read here stalls AE's whole main thread.
    // If testing shows AE hitching while the bridge is idle, lower this further.
    var READ_TIMEOUT_SEC = 0.05;
    // Writes need far longer than reads: a large response written with the
    // 50ms read timeout can be cut off mid-line.
    var WRITE_TIMEOUT_SEC = 10;
    // Drop a connection's buffered input if it grows this big with no newline.
    var MAX_RX_CHARS = 32 * 1024 * 1024;
    var LOG_PATH = Folder.temp.fsName + "/claude-ae-bridge.log";

    function log(msg) {
        try {
            var f = new File(LOG_PATH);
            f.open("a");
            f.writeln("[" + new Date().toString() + "] " + msg);
            f.close();
        } catch (e) {}
    }

    // ---------------------------------------------------------------------
    // Minimal JSON: use native JSON if this ExtendScript engine has it,
    // otherwise fall back to a small hand-rolled stringify + guarded-eval parse.
    // ---------------------------------------------------------------------
    function stringifyString(s) {
        return '"' + String(s).replace(/[\\"\x00-\x1f]/g, function (c) {
            var map = { '\\': '\\\\', '"': '\\"', '\n': '\\n', '\r': '\\r', '\t': '\\t' };
            if (map[c]) return map[c];
            var code = c.charCodeAt(0);
            return "\\u" + ("0000" + code.toString(16)).slice(-4);
        }) + '"';
    }
    function stringifyValue(v) {
        if (v === null || v === undefined) return "null";
        var t = typeof v;
        if (t === "number") return isFinite(v) ? String(v) : "null";
        if (t === "boolean") return String(v);
        if (t === "string") return stringifyString(v);
        if (v instanceof Array) {
            var parts = [];
            for (var i = 0; i < v.length; i++) parts.push(stringifyValue(v[i]));
            return "[" + parts.join(",") + "]";
        }
        if (t === "object") {
            var kparts = [];
            for (var k in v) {
                if (v.hasOwnProperty(k)) kparts.push(stringifyString(k) + ":" + stringifyValue(v[k]));
            }
            return "{" + kparts.join(",") + "}";
        }
        return "null";
    }
    function jsonStringify(v) {
        if (typeof JSON !== "undefined" && JSON.stringify) {
            try {
                // AE's native JSON.stringify writes an empty array as "[\n\n]".
                // The wire protocol is one message per line, so those raw
                // newlines split the response and the client drops it (the
                // call "times out" even though it succeeded). Newlines inside
                // string values are always escaped, so any raw CR/LF in the
                // output is structural whitespace and safe to strip.
                return JSON.stringify(v).replace(/[\r\n]+/g, "");
            } catch (e) { /* fall through */ }
        }
        return stringifyValue(v);
    }
    function jsonParse(text) {
        if (typeof JSON !== "undefined" && JSON.parse) return JSON.parse(text);
        // Guarded-eval fallback (the classic pre-JSON ExtendScript technique).
        if (!/^[\],:{}\s0-9.\-+Eaeflnru"\\bfnrtu]*$/.test(
            text.replace(/\\["\\\/bfnrtu]/g, '@')
                .replace(/"[^"\\\n\r]*"|true|false|null|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?/g, ']')
                .replace(/(?:^|:|,)(?:\s*\[)+/g, '')
        )) {
            throw new Error("Invalid JSON payload received");
        }
        return eval("(" + text + ")");
    }

    // ---------------------------------------------------------------------
    // AE DOM helpers
    // ---------------------------------------------------------------------
    function getComp(compIndex) {
        var item = app.project.item(compIndex);
        if (!item || !(item instanceof CompItem)) {
            throw new Error("No composition at index " + compIndex);
        }
        return item;
    }
    function getLayer(comp, layerIndex) {
        var layer = comp.layer(layerIndex);
        if (!layer) throw new Error("No layer at index " + layerIndex + " in comp '" + comp.name + "'");
        return layer;
    }
    function getEffect(layer, effectIndex) {
        var fx = layer.property("ADBE Effect Parade");
        var effect = fx.property(effectIndex);
        if (!effect) throw new Error("No effect at index " + effectIndex + " on layer '" + layer.name + "'");
        return effect;
    }
    // Item objects (comps, footage) have no .index property — only Layer
    // objects do. Resolve a project item's panel index by position instead.
    function findItemIndex(item) {
        for (var i = 1; i <= app.project.numItems; i++) {
            if (app.project.item(i) === item) return i;
        }
        return null;
    }
    // Builds a Shape object (vertices + bezier tangents) for a mask path or
    // a custom vector path. If inTangents/outTangents are omitted, zero
    // tangents are used (straight-line segments between vertices).
    function buildShape(vertices, inTangents, outTangents, closed) {
        var s = new Shape();
        s.vertices = vertices;
        var zero = [];
        for (var i = 0; i < vertices.length; i++) zero.push([0, 0]);
        s.inTangents = inTangents || zero;
        s.outTangents = outTangents || zero;
        s.closed = !!closed;
        return s;
    }

    // ---------------------------------------------------------------------
    // Op registry — the ONLY things a network client can trigger.
    // No raw eval of client-supplied script: every op validates its own args.
    // ---------------------------------------------------------------------
    var ops = {
        ping: function () {
            return { pong: true, appVersion: app.version, time: new Date().getTime() };
        },

        listCompositions: function () {
            var out = [];
            for (var i = 1; i <= app.project.numItems; i++) {
                var it = app.project.item(i);
                if (it instanceof CompItem) {
                    out.push({
                        index: i, name: it.name, width: it.width, height: it.height,
                        duration: it.duration, frameRate: it.frameRate
                    });
                }
            }
            return { compositions: out };
        },

        createComposition: function (a) {
            if (!a.name) throw new Error("createComposition requires 'name'");
            var comp = app.project.items.addComp(
                a.name,
                a.width || 1920,
                a.height || 1080,
                a.pixelAspect || 1.0,
                a.duration || 10.0,
                a.frameRate || 30.0
            );
            return { index: findItemIndex(comp), name: comp.name, width: comp.width, height: comp.height };
        },

        duplicateComposition: function (a) {
            var comp = getComp(a.compIndex);
            var dup = comp.duplicate();
            if (a.name) dup.name = a.name;
            return { index: findItemIndex(dup), name: dup.name };
        },

        setCompositionSettings: function (a) {
            var comp = getComp(a.compIndex);
            if (a.width !== undefined) comp.width = a.width;
            if (a.height !== undefined) comp.height = a.height;
            if (a.duration !== undefined) comp.duration = a.duration;
            if (a.frameRate !== undefined) comp.frameRate = a.frameRate;
            if (a.pixelAspect !== undefined) comp.pixelAspect = a.pixelAspect;
            if (a.bgColor !== undefined) comp.bgColor = a.bgColor;
            if (a.workAreaStart !== undefined) comp.workAreaStart = a.workAreaStart;
            if (a.workAreaDuration !== undefined) comp.workAreaDuration = a.workAreaDuration;
            return {
                name: comp.name, width: comp.width, height: comp.height,
                duration: comp.duration, frameRate: comp.frameRate
            };
        },

        openComposition: function (a) {
            var comp = getComp(a.compIndex);
            comp.openInViewer();
            return { opened: comp.name };
        },

        listLayers: function (a) {
            var comp = getComp(a.compIndex);
            var out = [];
            for (var i = 1; i <= comp.numLayers; i++) {
                var l = comp.layer(i);
                out.push({ index: i, name: l.name, enabled: l.enabled, locked: l.locked, matchName: l.matchName });
            }
            return { layers: out };
        },

        // Shape layers: matchNames confirmed against the official
        // "Shape Layer Match Names" reference (ae-scripting.docsforadobe.dev),
        // but the sub-property names used for a shape's own geometry
        // ("Size"/"Position"/"Roundness") follow AE's UI labels rather than
        // a confirmed doc source — unverified against a live AE instance,
        // report back if any errors.
        createShapeLayer: function (a) {
            var comp = getComp(a.compIndex);
            var layer = comp.layers.addShape();
            if (a.name) layer.name = a.name;
            return { index: layer.index, name: layer.name };
        },

        addShapeGroup: function (a) {
            var comp = getComp(a.compIndex);
            var layer = getLayer(comp, a.layerIndex);
            var contents = layer.property("ADBE Root Vectors Group");
            var group = contents.addProperty("ADBE Vector Group");
            if (a.name) group.name = a.name;
            return { groupIndex: group.propertyIndex, name: group.name };
        },

        addShapePrimitive: function (a) {
            if (!a.shapeType) throw new Error("addShapePrimitive requires 'shapeType' ('rect', 'ellipse', or 'path')");
            if (!a.groupIndex) throw new Error("addShapePrimitive requires 'groupIndex' (from addShapeGroup)");
            var comp = getComp(a.compIndex);
            var layer = getLayer(comp, a.layerIndex);
            var contents = layer.property("ADBE Root Vectors Group");
            var group = contents.property(a.groupIndex);
            if (!group) throw new Error("No shape group at index " + a.groupIndex);
            var groupContents = group.property("ADBE Vectors Group");
            var shape;
            if (a.shapeType === "rect") {
                shape = groupContents.addProperty("ADBE Vector Shape - Rect");
                if (a.size) shape.property("Size").setValue(a.size);
                if (a.position) shape.property("Position").setValue(a.position);
                if (a.roundness !== undefined) shape.property("Roundness").setValue(a.roundness);
            } else if (a.shapeType === "ellipse") {
                shape = groupContents.addProperty("ADBE Vector Shape - Ellipse");
                if (a.size) shape.property("Size").setValue(a.size);
                if (a.position) shape.property("Position").setValue(a.position);
            } else if (a.shapeType === "path") {
                if (!a.vertices || !a.vertices.length) throw new Error("path shapeType requires 'vertices'");
                shape = groupContents.addProperty("ADBE Vector Shape - Group");
                shape.property("Path").setValue(buildShape(a.vertices, a.inTangents, a.outTangents, a.closed));
            } else {
                throw new Error("Unknown shapeType '" + a.shapeType + "'");
            }
            return { propertyIndex: shape.propertyIndex, name: shape.name };
        },

        addShapeFill: function (a) {
            if (!a.groupIndex) throw new Error("addShapeFill requires 'groupIndex' (from addShapeGroup)");
            var comp = getComp(a.compIndex);
            var layer = getLayer(comp, a.layerIndex);
            var group = layer.property("ADBE Root Vectors Group").property(a.groupIndex);
            if (!group) throw new Error("No shape group at index " + a.groupIndex);
            var fill = group.property("ADBE Vectors Group").addProperty("ADBE Vector Graphic - Fill");
            if (a.color) fill.property("Color").setValue(a.color);
            if (a.opacity !== undefined) fill.property("Opacity").setValue(a.opacity);
            return { propertyIndex: fill.propertyIndex, name: fill.name };
        },

        addShapeStroke: function (a) {
            if (!a.groupIndex) throw new Error("addShapeStroke requires 'groupIndex' (from addShapeGroup)");
            var comp = getComp(a.compIndex);
            var layer = getLayer(comp, a.layerIndex);
            var group = layer.property("ADBE Root Vectors Group").property(a.groupIndex);
            if (!group) throw new Error("No shape group at index " + a.groupIndex);
            var stroke = group.property("ADBE Vectors Group").addProperty("ADBE Vector Graphic - Stroke");
            if (a.color) stroke.property("Color").setValue(a.color);
            if (a.width !== undefined) stroke.property("Stroke Width").setValue(a.width);
            if (a.opacity !== undefined) stroke.property("Opacity").setValue(a.opacity);
            return { propertyIndex: stroke.propertyIndex, name: stroke.name };
        },

        // Path operations (Trim/Merge/Repeater/etc.) — matchNames confirmed
        // against the official Shape Layer Match Names reference. Generic
        // like applyEffect: settings is a map of property name -> value.
        // CONFIRMED LIVE (user inspection of the real Contents panel):
        // "ADBE Vector Filter - RC" (Round Corners) adds correctly with the
        // right Radius value, but produces no visible effect on either a
        // Rectangle primitive or a custom freeform path — for a Rectangle,
        // use its own 'roundness' param on ae_add_shape_primitive instead.
        // Cause not fully root-caused; other path operations (Trim, Merge,
        // Repeater, etc.) are unverified and may or may not share this issue.
        addShapePathOperation: function (a) {
            if (!a.matchName) throw new Error("addShapePathOperation requires 'matchName' (e.g. 'ADBE Vector Filter - Trim')");
            if (!a.groupIndex) throw new Error("addShapePathOperation requires 'groupIndex' (from addShapeGroup)");
            var comp = getComp(a.compIndex);
            var layer = getLayer(comp, a.layerIndex);
            var group = layer.property("ADBE Root Vectors Group").property(a.groupIndex);
            if (!group) throw new Error("No shape group at index " + a.groupIndex);
            var pathOp = group.property("ADBE Vectors Group").addProperty(a.matchName);
            if (!pathOp) throw new Error("Could not add path operation '" + a.matchName + "'");
            var appliedSettings = {};
            var availableProps = [];
            for (var pi = 1; pi <= pathOp.numProperties; pi++) {
                try { availableProps.push(pathOp.property(pi).name); } catch (eName) {}
            }
            if (a.settings) {
                for (var key in a.settings) {
                    if (!a.settings.hasOwnProperty(key)) continue;
                    var prop = pathOp.property(key);
                    if (prop) {
                        prop.setValue(a.settings[key]);
                        appliedSettings[key] = { applied: true, valueAfter: prop.value };
                    } else {
                        appliedSettings[key] = { applied: false, reason: "property not found by that name" };
                    }
                }
            }
            return {
                propertyIndex: pathOp.propertyIndex,
                name: pathOp.name,
                availableProps: availableProps,
                appliedSettings: appliedSettings
            };
        },

        // The group's OWN transform (position/scale/rotation/anchor of the
        // whole group), distinct from a shape primitive's local position.
        // "ADBE Vector Transform Group" confirmed against community
        // ExtendScript examples using the identical matchName.
        setShapeGroupTransform: function (a) {
            if (!a.propertyName) throw new Error("setShapeGroupTransform requires 'propertyName'");
            if (!a.groupIndex) throw new Error("setShapeGroupTransform requires 'groupIndex'");
            var comp = getComp(a.compIndex);
            var layer = getLayer(comp, a.layerIndex);
            var group = layer.property("ADBE Root Vectors Group").property(a.groupIndex);
            if (!group) throw new Error("No shape group at index " + a.groupIndex);
            var transform = group.property("ADBE Vector Transform Group");
            var prop = transform.property(a.propertyName);
            if (!prop) throw new Error("No property '" + a.propertyName + "' on shape group transform");
            prop.setValue(a.value);
            return { group: group.name, property: prop.name };
        },

        // Masks: adding via layer.property("Masks").addProperty("Mask") and
        // setting "Mask Path" with a Shape object is a widely-used community
        // pattern, corroborated across multiple independent sources, but not
        // from the docsforadobe MaskPropertyGroup page itself (which only
        // documents existing-mask attributes, not creation) — flagging as
        // slightly less certain than the shape/text matchNames above.
        addMask: function (a) {
            if (!a.vertices || !a.vertices.length) throw new Error("addMask requires 'vertices'");
            var comp = getComp(a.compIndex);
            var layer = getLayer(comp, a.layerIndex);
            var mask = layer.property("Masks").addProperty("Mask");
            if (a.name) mask.name = a.name;
            mask.property("Mask Path").setValue(buildShape(a.vertices, a.inTangents, a.outTangents, a.closed !== false));
            if (a.maskMode) {
                if (!MaskMode[a.maskMode]) throw new Error("Unknown maskMode '" + a.maskMode + "'");
                mask.maskMode = MaskMode[a.maskMode];
            }
            return { index: mask.propertyIndex, name: mask.name };
        },

        listMasks: function (a) {
            var comp = getComp(a.compIndex);
            var layer = getLayer(comp, a.layerIndex);
            var masksGroup = layer.property("Masks");
            var out = [];
            for (var i = 1; i <= masksGroup.numProperties; i++) {
                var m = masksGroup.property(i);
                out.push({ index: i, name: m.name });
            }
            return { masks: out };
        },

        setMaskProperty: function (a) {
            if (!a.propertyName) throw new Error("setMaskProperty requires 'propertyName' (e.g. 'Mask Feather', 'Mask Opacity', 'Mask Expansion', 'Mask Path')");
            var comp = getComp(a.compIndex);
            var layer = getLayer(comp, a.layerIndex);
            var mask = layer.property("Masks").property(a.maskIndex);
            if (!mask) throw new Error("No mask at index " + a.maskIndex);
            var prop = mask.property(a.propertyName);
            if (!prop) throw new Error("No property '" + a.propertyName + "' on mask '" + mask.name + "'");
            prop.setValue(a.value);
            return { mask: mask.name, property: prop.name };
        },

        // Text animators: matchNames confirmed against both the official
        // "Text Layer Match Names" reference and an independent community
        // ExtendScript example using the identical matchNames.
        addTextAnimator: function (a) {
            var comp = getComp(a.compIndex);
            var layer = getLayer(comp, a.layerIndex);
            var animators = layer.property("Text").property("ADBE Text Animators");
            var animator = animators.addProperty("ADBE Text Animator");
            if (a.name) animator.name = a.name;
            var selector = animator.property("ADBE Text Selectors").addProperty("ADBE Text Selector");
            if (a.startPercent !== undefined) selector.property("ADBE Text Percent Start").setValue(a.startPercent);
            if (a.endPercent !== undefined) selector.property("ADBE Text Percent End").setValue(a.endPercent);
            return { animatorIndex: animator.propertyIndex, name: animator.name };
        },

        addAnimatorProperty: function (a) {
            if (!a.animatorIndex) throw new Error("addAnimatorProperty requires 'animatorIndex' (from addTextAnimator)");
            if (!a.matchName) throw new Error("addAnimatorProperty requires 'matchName' (e.g. 'ADBE Text Position 3D', 'ADBE Text Opacity', 'ADBE Text Fill Color')");
            var comp = getComp(a.compIndex);
            var layer = getLayer(comp, a.layerIndex);
            var animator = layer.property("Text").property("ADBE Text Animators").property(a.animatorIndex);
            if (!animator) throw new Error("No animator at index " + a.animatorIndex);
            var props = animator.property("ADBE Text Animator Properties");
            var prop = props.addProperty(a.matchName);
            if (!prop) throw new Error("Could not add animator property '" + a.matchName + "'");
            if (a.value !== undefined) prop.setValue(a.value);
            return { propertyIndex: prop.propertyIndex, name: prop.name };
        },

        setAnimatorSelectorRange: function (a) {
            if (!a.animatorIndex) throw new Error("setAnimatorSelectorRange requires 'animatorIndex'");
            var comp = getComp(a.compIndex);
            var layer = getLayer(comp, a.layerIndex);
            var animator = layer.property("Text").property("ADBE Text Animators").property(a.animatorIndex);
            if (!animator) throw new Error("No animator at index " + a.animatorIndex);
            var selector = animator.property("ADBE Text Selectors").property(a.selectorIndex || 1);
            if (!selector) throw new Error("No selector at index " + (a.selectorIndex || 1));
            if (a.startPercent !== undefined) selector.property("ADBE Text Percent Start").setValue(a.startPercent);
            if (a.endPercent !== undefined) selector.property("ADBE Text Percent End").setValue(a.endPercent);
            if (a.offsetPercent !== undefined) selector.property("ADBE Text Percent Offset").setValue(a.offsetPercent);
            return { animator: animator.name, selector: selector.name };
        },

        createSolid: function (a) {
            var comp = getComp(a.compIndex);
            var color = a.color || [1, 1, 1];
            var layer = comp.layers.addSolid(
                color,
                a.name || "Solid",
                a.width || comp.width,
                a.height || comp.height,
                a.pixelAspect || 1.0,
                a.duration || comp.duration
            );
            return { index: layer.index, name: layer.name };
        },

        createText: function (a) {
            if (!a.text) throw new Error("createText requires 'text'");
            var comp = getComp(a.compIndex);
            var layer = comp.layers.addText(a.text);
            var textProp = layer.property("Source Text");
            var doc = textProp.value;
            var changed = false;
            if (a.font) { doc.font = a.font; changed = true; }
            if (a.fontSize) { doc.fontSize = a.fontSize; changed = true; }
            if (a.fillColor) { doc.fillColor = a.fillColor; changed = true; }
            if (changed) textProp.setValue(doc);
            if (a.position) layer.property("Transform").property("Position").setValue(a.position);
            return { index: layer.index, name: layer.name };
        },

        createNull: function (a) {
            var comp = getComp(a.compIndex);
            var layer = comp.layers.addNull(a.duration || comp.duration);
            if (a.name) layer.name = a.name;
            return { index: layer.index, name: layer.name };
        },

        createCamera: function (a) {
            var comp = getComp(a.compIndex);
            var centerPoint = a.centerPoint || [comp.width / 2, comp.height / 2];
            var layer = comp.layers.addCamera(a.name || "Camera", centerPoint);
            return { index: layer.index, name: layer.name };
        },

        createLight: function (a) {
            var comp = getComp(a.compIndex);
            var centerPoint = a.centerPoint || [comp.width / 2, comp.height / 2];
            var layer = comp.layers.addLight(a.name || "Light", centerPoint);
            if (a.lightType) {
                if (!LightType[a.lightType]) throw new Error("Unknown lightType '" + a.lightType + "' (try PARALLEL, SPOT, POINT, AMBIENT)");
                layer.lightType = LightType[a.lightType];
            }
            return { index: layer.index, name: layer.name };
        },

        createAdjustmentLayer: function (a) {
            var comp = getComp(a.compIndex);
            var layer = comp.layers.addSolid(
                [1, 1, 1],
                a.name || "Adjustment Layer",
                a.width || comp.width,
                a.height || comp.height,
                a.pixelAspect || 1.0,
                a.duration || comp.duration
            );
            layer.adjustmentLayer = true;
            return { index: layer.index, name: layer.name };
        },

        precompose: function (a) {
            if (!a.layerIndices || !a.layerIndices.length) throw new Error("precompose requires 'layerIndices' (array of 1-based layer indices)");
            var comp = getComp(a.compIndex);
            var newComp = comp.layers.precompose(a.layerIndices, a.name || "Precomp", a.moveAllAttributes !== false);
            return { index: findItemIndex(newComp), name: newComp.name };
        },

        duplicateLayer: function (a) {
            var comp = getComp(a.compIndex);
            var layer = getLayer(comp, a.layerIndex);
            var dup = layer.duplicate();
            return { index: dup.index, name: dup.name };
        },

        deleteLayer: function (a) {
            var comp = getComp(a.compIndex);
            var layer = getLayer(comp, a.layerIndex);
            var name = layer.name;
            layer.remove();
            return { removed: name };
        },

        moveLayer: function (a) {
            var comp = getComp(a.compIndex);
            var layer = getLayer(comp, a.layerIndex);
            if (a.toTop) layer.moveToBeginning();
            else if (a.toBottom) layer.moveToEnd();
            else if (a.aboveLayerIndex) layer.moveBefore(getLayer(comp, a.aboveLayerIndex));
            else if (a.belowLayerIndex) layer.moveAfter(getLayer(comp, a.belowLayerIndex));
            else throw new Error("moveLayer requires one of toTop, toBottom, aboveLayerIndex, belowLayerIndex");
            return { index: layer.index, name: layer.name };
        },

        setLayerParent: function (a) {
            var comp = getComp(a.compIndex);
            var layer = getLayer(comp, a.layerIndex);
            if (a.parentLayerIndex === undefined || a.parentLayerIndex === null) {
                layer.parent = null;
            } else {
                layer.parent = getLayer(comp, a.parentLayerIndex);
            }
            return { layer: layer.name, parent: layer.parent ? layer.parent.name : null };
        },

        setLayerTiming: function (a) {
            var comp = getComp(a.compIndex);
            var layer = getLayer(comp, a.layerIndex);
            if (a.startTime !== undefined) layer.startTime = a.startTime;
            if (a.inPoint !== undefined) layer.inPoint = a.inPoint;
            if (a.outPoint !== undefined) layer.outPoint = a.outPoint;
            return { layer: layer.name, startTime: layer.startTime, inPoint: layer.inPoint, outPoint: layer.outPoint };
        },

        splitLayer: function (a) {
            var comp = getComp(a.compIndex);
            var layer = getLayer(comp, a.layerIndex);
            var t = (a.timeInSeconds !== undefined && a.timeInSeconds !== null) ? a.timeInSeconds : comp.time;
            var dup = layer.duplicate();
            layer.outPoint = t;
            dup.inPoint = t;
            return { firstIndex: layer.index, secondIndex: dup.index, splitAt: t };
        },

        setLayerFlags: function (a) {
            var comp = getComp(a.compIndex);
            var layer = getLayer(comp, a.layerIndex);
            if (a.threeDLayer !== undefined) layer.threeDLayer = a.threeDLayer;
            if (a.blendMode !== undefined) {
                if (!BlendingMode[a.blendMode]) throw new Error("Unknown blendMode '" + a.blendMode + "'");
                layer.blendingMode = BlendingMode[a.blendMode];
            }
            if (a.trackMatteType !== undefined) {
                if (!TrackMatteType[a.trackMatteType]) throw new Error("Unknown trackMatteType '" + a.trackMatteType + "'");
                layer.trackMatteType = TrackMatteType[a.trackMatteType];
            }
            if (a.solo !== undefined) layer.solo = a.solo;
            if (a.shy !== undefined) layer.shy = a.shy;
            if (a.locked !== undefined) layer.locked = a.locked;
            if (a.enabled !== undefined) layer.enabled = a.enabled;
            if (a.label !== undefined) layer.label = a.label;
            if (a.audioEnabled !== undefined) layer.audioEnabled = a.audioEnabled;
            return { layer: layer.name };
        },

        renameLayer: function (a) {
            if (!a.name) throw new Error("renameLayer requires 'name'");
            var comp = getComp(a.compIndex);
            var layer = getLayer(comp, a.layerIndex);
            layer.name = a.name;
            return { layer: layer.name };
        },

        importFootage: function (a) {
            if (!a.filePath) throw new Error("importFootage requires 'filePath'");
            var file = new File(a.filePath);
            if (!file.exists) throw new Error("File not found: " + a.filePath);
            var footageItem = app.project.importFile(new ImportOptions(file));
            var result = { itemIndex: findItemIndex(footageItem), name: footageItem.name };
            if (a.compIndex) {
                var comp = getComp(a.compIndex);
                var layer = comp.layers.add(footageItem);
                result.layerIndex = layer.index;
            }
            return result;
        },

        listProjectItems: function () {
            var out = [];
            for (var i = 1; i <= app.project.numItems; i++) {
                var it = app.project.item(i);
                var entry = { index: i, name: it.name, typeName: it.typeName };
                if (it instanceof CompItem) {
                    entry.kind = "composition";
                    entry.width = it.width;
                    entry.height = it.height;
                } else if (it instanceof FootageItem) {
                    entry.kind = "footage";
                    entry.missing = !!it.footageMissing;
                    if (it.mainSource && it.mainSource.file) entry.filePath = it.mainSource.file.fsName;
                } else {
                    entry.kind = "folder";
                }
                out.push(entry);
            }
            return { items: out };
        },

        createFolder: function (a) {
            if (!a.name) throw new Error("createFolder requires 'name'");
            var folder = app.project.items.addFolder(a.name);
            return { index: findItemIndex(folder), name: folder.name };
        },

        replaceFootageSource: function (a) {
            if (!a.itemIndex) throw new Error("replaceFootageSource requires 'itemIndex'");
            if (!a.filePath) throw new Error("replaceFootageSource requires 'filePath'");
            var item = app.project.item(a.itemIndex);
            if (!item || !(item instanceof FootageItem)) throw new Error("No footage item at index " + a.itemIndex);
            var file = new File(a.filePath);
            if (!file.exists) throw new Error("File not found: " + a.filePath);
            item.replace(file);
            return { index: a.itemIndex, name: item.name };
        },

        // app.fonts.allFonts confirmed against the official FontsObject/
        // FontObject reference (AE 24.0+). Returns fonts grouped by family;
        // flattened here. Unverified against a live AE instance yet.
        listAvailableFonts: function (a) {
            var query = (a.query || "").toLowerCase();
            var out = [];
            var families = app.fonts.allFonts;
            for (var i = 0; i < families.length; i++) {
                var family = families[i];
                for (var j = 0; j < family.length; j++) {
                    var f = family[j];
                    if (query) {
                        var hay = (f.familyName + " " + f.styleName + " " + f.postScriptName).toLowerCase();
                        if (hay.indexOf(query) === -1) continue;
                    }
                    out.push({
                        postScriptName: f.postScriptName,
                        familyName: f.familyName,
                        styleName: f.styleName,
                        fullName: f.fullName
                    });
                    if (out.length >= (a.maxResults || 200)) return { fonts: out };
                }
            }
            return { fonts: out };
        },

        listAvailableEffects: function (a) {
            // NOTE: app.effects is the documented enumeration API for installed
            // effects, but this op is unverified against a live AE instance —
            // report back if it errors and we'll adjust.
            var query = (a.query || "").toLowerCase();
            var out = [];
            var effects = app.effects;
            for (var i = 0; i < effects.length; i++) {
                var e = effects[i];
                if (query) {
                    var hay = (e.displayName + " " + e.matchName + " " + (e.category || "")).toLowerCase();
                    if (hay.indexOf(query) === -1) continue;
                }
                out.push({ displayName: e.displayName, matchName: e.matchName, category: e.category });
                if (out.length >= (a.maxResults || 200)) break;
            }
            return { effects: out };
        },

        listEffects: function (a) {
            var comp = getComp(a.compIndex);
            var layer = getLayer(comp, a.layerIndex);
            var fx = layer.property("ADBE Effect Parade");
            var out = [];
            for (var i = 1; i <= fx.numProperties; i++) {
                var e = fx.property(i);
                out.push({ index: i, name: e.name, matchName: e.matchName, enabled: e.enabled });
            }
            return { effects: out };
        },

        applyEffect: function (a) {
            if (!a.matchName) throw new Error("applyEffect requires 'matchName' (e.g. 'ADBE Gaussian Blur 2')");
            var comp = getComp(a.compIndex);
            var layer = getLayer(comp, a.layerIndex);
            var fx = layer.property("ADBE Effect Parade");
            var effect = fx.addProperty(a.matchName);
            if (!effect) {
                throw new Error("Could not apply effect '" + a.matchName + "' — check the matchName is valid for this AE installation.");
            }
            if (a.settings) {
                for (var key in a.settings) {
                    if (!a.settings.hasOwnProperty(key)) continue;
                    var prop = effect.property(key);
                    if (prop) prop.setValue(a.settings[key]);
                }
            }
            return { index: effect.propertyIndex, name: effect.name, matchName: effect.matchName };
        },

        removeEffect: function (a) {
            var comp = getComp(a.compIndex);
            var layer = getLayer(comp, a.layerIndex);
            var effect = getEffect(layer, a.effectIndex);
            var name = effect.name;
            effect.remove();
            return { removed: name };
        },

        applyEffectPreset: function (a) {
            if (!a.presetPath) throw new Error("applyEffectPreset requires 'presetPath'");
            var comp = getComp(a.compIndex);
            var layer = getLayer(comp, a.layerIndex);
            var file = new File(a.presetPath);
            if (!file.exists) throw new Error("Preset file not found: " + a.presetPath);
            layer.applyPreset(file);
            return { layer: layer.name, preset: a.presetPath };
        },

        reorderEffect: function (a) {
            if (a.toIndex === undefined) throw new Error("reorderEffect requires 'toIndex'");
            var comp = getComp(a.compIndex);
            var layer = getLayer(comp, a.layerIndex);
            var effect = getEffect(layer, a.effectIndex);
            var name = effect.name;
            effect.moveTo(a.toIndex);
            // moveTo() invalidates the moved property's own reference (and its
            // siblings') per the PropertyBase docs — re-fetch fresh at the new
            // position instead of touching the stale `effect` reference again.
            var moved = getEffect(layer, a.toIndex);
            return { layer: layer.name, effect: name, newIndex: moved.propertyIndex };
        },

        setEffectEnabled: function (a) {
            if (a.enabled === undefined) throw new Error("setEffectEnabled requires 'enabled'");
            var comp = getComp(a.compIndex);
            var layer = getLayer(comp, a.layerIndex);
            var effect = getEffect(layer, a.effectIndex);
            effect.enabled = a.enabled;
            return { layer: layer.name, effect: effect.name, enabled: effect.enabled };
        },

        setEffectProperty: function (a) {
            if (!a.propertyName) throw new Error("setEffectProperty requires 'propertyName'");
            var comp = getComp(a.compIndex);
            var layer = getLayer(comp, a.layerIndex);
            var effect = getEffect(layer, a.effectIndex);
            var prop = effect.property(a.propertyName);
            if (!prop) throw new Error("No property '" + a.propertyName + "' on effect '" + effect.name + "'");
            // Scalar range guard: AE exposes hasMin/hasMax + minValue/maxValue per
            // property, but only setValue's own runtime error tells you the range —
            // by then it's a modal dialog (over -r) or a hard failure (over the
            // bridge), not a catchable, informative one. Check first for plain
            // numbers (multi-dimensional values like colors/points are skipped —
            // AE's range semantics there are less consistently meaningful).
            if (typeof a.value === "number") {
                if (prop.hasMin && a.value < prop.minValue) {
                    throw new Error(
                        "setEffectProperty: value " + a.value + " for '" + a.propertyName +
                        "' on '" + effect.name + "' is below its minimum (" + prop.minValue + ")"
                    );
                }
                if (prop.hasMax && a.value > prop.maxValue) {
                    throw new Error(
                        "setEffectProperty: value " + a.value + " for '" + a.propertyName +
                        "' on '" + effect.name + "' is above its maximum (" + prop.maxValue + ")"
                    );
                }
            }
            if (a.timeInSeconds !== undefined && a.timeInSeconds !== null) {
                prop.setValueAtTime(a.timeInSeconds, a.value);
            } else {
                prop.setValue(a.value);
            }
            return { effect: effect.name, property: prop.name };
        },

        setLayerProperty: function (a) {
            if (!a.propertyName) throw new Error("setLayerProperty requires 'propertyName'");
            var comp = getComp(a.compIndex);
            var layer = getLayer(comp, a.layerIndex);
            var prop = layer.property(a.propertyName);
            if (!prop) throw new Error("No property '" + a.propertyName + "' on layer '" + layer.name + "'");
            prop.setValue(a.value);
            return { layer: layer.name, property: prop.name };
        },

        setLayerKeyframe: function (a) {
            if (!a.propertyName) throw new Error("setLayerKeyframe requires 'propertyName'");
            if (a.timeInSeconds === undefined || a.timeInSeconds === null) throw new Error("setLayerKeyframe requires 'timeInSeconds'");
            var comp = getComp(a.compIndex);
            var layer = getLayer(comp, a.layerIndex);
            var prop = layer.property(a.propertyName);
            if (!prop) throw new Error("No property '" + a.propertyName + "' on layer '" + layer.name + "'");
            prop.setValueAtTime(a.timeInSeconds, a.value);
            return { layer: layer.name, property: prop.name, time: a.timeInSeconds };
        },

        listKeyframes: function (a) {
            if (!a.propertyName) throw new Error("listKeyframes requires 'propertyName'");
            var comp = getComp(a.compIndex);
            var layer = getLayer(comp, a.layerIndex);
            var prop = layer.property(a.propertyName);
            if (!prop) throw new Error("No property '" + a.propertyName + "' on layer '" + layer.name + "'");
            var out = [];
            for (var i = 1; i <= prop.numKeys; i++) {
                // keyValue() for complex property types (Shape, TextDocument,
                // Marker) may not serialize cleanly through jsonStringify's
                // plain object/array walk — fine for the common case
                // (transform/effect numeric or array properties).
                out.push({ index: i, time: prop.keyTime(i), value: prop.keyValue(i) });
            }
            return { property: prop.name, numKeys: prop.numKeys, keyframes: out };
        },

        removeKeyframe: function (a) {
            if (!a.propertyName) throw new Error("removeKeyframe requires 'propertyName'");
            var comp = getComp(a.compIndex);
            var layer = getLayer(comp, a.layerIndex);
            var prop = layer.property(a.propertyName);
            if (!prop) throw new Error("No property '" + a.propertyName + "' on layer '" + layer.name + "'");
            if (a.keyframeIndex) {
                prop.removeKey(a.keyframeIndex);
            } else if (a.all) {
                while (prop.numKeys > 0) prop.removeKey(1);
            } else {
                throw new Error("removeKeyframe requires 'keyframeIndex' or 'all: true'");
            }
            return { layer: layer.name, property: prop.name, remainingKeys: prop.numKeys };
        },

        // Unverified against a live AE instance — KeyframeEase/interpolation
        // constants are documented but not yet tested through this bridge.
        setKeyframeEasing: function (a) {
            if (!a.propertyName) throw new Error("setKeyframeEasing requires 'propertyName'");
            if (!a.keyframeIndex) throw new Error("setKeyframeEasing requires 'keyframeIndex'");
            var comp = getComp(a.compIndex);
            var layer = getLayer(comp, a.layerIndex);
            var prop = layer.property(a.propertyName);
            if (!prop) throw new Error("No property '" + a.propertyName + "' on layer '" + layer.name + "'");
            var ki = a.keyframeIndex;

            if (a.interpolationIn || a.interpolationOut) {
                var typeMap = {
                    linear: KeyframeInterpolationType.LINEAR,
                    bezier: KeyframeInterpolationType.BEZIER,
                    hold: KeyframeInterpolationType.HOLD
                };
                if (a.interpolationIn && !typeMap[a.interpolationIn]) throw new Error("Unknown interpolationIn '" + a.interpolationIn + "'");
                if (a.interpolationOut && !typeMap[a.interpolationOut]) throw new Error("Unknown interpolationOut '" + a.interpolationOut + "'");
                var inType = a.interpolationIn ? typeMap[a.interpolationIn] : prop.keyInInterpolationType(ki);
                var outType = a.interpolationOut ? typeMap[a.interpolationOut] : prop.keyOutInterpolationType(ki);
                prop.setInterpolationTypeAtKey(ki, inType, outType);
            }

            if (a.easyEase) {
                var influence = a.easyEaseInfluence || 33.333;
                // setTemporalEaseAtKey wants ONE ease entry per dimension only
                // when the property's dimensions are separated (each axis
                // keyframed independently). Normally (the common case) it's
                // always a single combined temporal channel, even for a
                // multi-axis property like Position — passing one entry per
                // axis there throws "Value array does not have N elements".
                var dim = prop.dimensionsSeparated && (prop.value instanceof Array) ? prop.value.length : 1;
                var easeArr = [];
                for (var d = 0; d < dim; d++) easeArr.push(new KeyframeEase(0, influence));
                prop.setTemporalEaseAtKey(ki, easeArr, easeArr);
            }

            return { layer: layer.name, property: prop.name, keyframeIndex: ki };
        },

        setTimeRemapping: function (a) {
            var comp = getComp(a.compIndex);
            var layer = getLayer(comp, a.layerIndex);
            if (!layer.timeRemapEnabled) layer.timeRemapEnabled = true;
            var prop = layer.property("Time Remap");
            if (a.timeInSeconds !== undefined && a.value !== undefined) {
                prop.setValueAtTime(a.timeInSeconds, a.value);
            }
            return { layer: layer.name, timeRemapEnabled: layer.timeRemapEnabled };
        },

        setLayerMotionBlur: function (a) {
            if (a.enabled === undefined) throw new Error("setLayerMotionBlur requires 'enabled'");
            var comp = getComp(a.compIndex);
            var layer = getLayer(comp, a.layerIndex);
            layer.motionBlur = a.enabled;
            return { layer: layer.name, motionBlur: layer.motionBlur };
        },

        setLayerExpression: function (a) {
            if (!a.propertyName) throw new Error("setLayerExpression requires 'propertyName'");
            var comp = getComp(a.compIndex);
            var layer = getLayer(comp, a.layerIndex);
            var prop = layer.property(a.propertyName);
            if (!prop) throw new Error("No property '" + a.propertyName + "' on layer '" + layer.name + "'");
            prop.expression = a.expressionString || "";
            return { layer: layer.name, property: prop.name, expressionSet: !!a.expressionString };
        },

        addMarker: function (a) {
            if (a.timeInSeconds === undefined || a.timeInSeconds === null) throw new Error("addMarker requires 'timeInSeconds'");
            var comp = getComp(a.compIndex);
            var target;
            if (a.layerIndex) {
                target = getLayer(comp, a.layerIndex).property("Marker");
            } else {
                target = comp.markerProperty;
            }
            var m = new MarkerValue(a.comment || "");
            target.setValueAtTime(a.timeInSeconds, m);
            return { added: true, time: a.timeInSeconds };
        },

        addMarkersBulk: function (a) {
            if (!a.markers || !a.markers.length) throw new Error("addMarkersBulk requires a non-empty 'markers' array");
            var comp = getComp(a.compIndex);
            var target = a.layerIndex ? getLayer(comp, a.layerIndex).property("Marker") : comp.markerProperty;
            for (var i = 0; i < a.markers.length; i++) {
                var mk = a.markers[i];
                if (mk.timeInSeconds === undefined || mk.timeInSeconds === null) throw new Error("Each marker requires 'timeInSeconds'");
                target.setValueAtTime(mk.timeInSeconds, new MarkerValue(mk.comment || ""));
            }
            return { added: a.markers.length };
        },

        listMarkers: function (a) {
            var comp = getComp(a.compIndex);
            var target = a.layerIndex ? getLayer(comp, a.layerIndex).property("Marker") : comp.markerProperty;
            var out = [];
            for (var i = 1; i <= target.numKeys; i++) {
                out.push({ index: i, time: target.keyTime(i), comment: target.keyValue(i).comment });
            }
            return { markers: out };
        },

        removeMarker: function (a) {
            if (!a.markerIndex) throw new Error("removeMarker requires 'markerIndex'");
            var comp = getComp(a.compIndex);
            var target = a.layerIndex ? getLayer(comp, a.layerIndex).property("Marker") : comp.markerProperty;
            target.removeKey(a.markerIndex);
            return { removed: a.markerIndex };
        },

        getCurrentTime: function (a) {
            var comp = getComp(a.compIndex);
            return { time: comp.time, workAreaStart: comp.workAreaStart, workAreaDuration: comp.workAreaDuration };
        },

        setCurrentTime: function (a) {
            if (a.timeInSeconds === undefined) throw new Error("setCurrentTime requires 'timeInSeconds'");
            var comp = getComp(a.compIndex);
            comp.time = a.timeInSeconds;
            return { time: comp.time };
        },

        setWorkArea: function (a) {
            var comp = getComp(a.compIndex);
            if (a.start !== undefined) comp.workAreaStart = a.start;
            if (a.duration !== undefined) comp.workAreaDuration = a.duration;
            return { workAreaStart: comp.workAreaStart, workAreaDuration: comp.workAreaDuration };
        },

        getLayerBounds: function (a) {
            var comp = getComp(a.compIndex);
            var layer = getLayer(comp, a.layerIndex);
            var t = (a.timeInSeconds !== undefined && a.timeInSeconds !== null) ? a.timeInSeconds : comp.time;
            var bounds = layer.sourceRectAtTime(t, false);
            return { layer: layer.name, top: bounds.top, left: bounds.left, width: bounds.width, height: bounds.height };
        },

        // Unverified against a live AE instance — saveFrameToPng was added
        // in a relatively recent AE version; report back if it errors.
        exportFrame: function (a) {
            if (!a.outputPath) throw new Error("exportFrame requires 'outputPath'");
            var comp = getComp(a.compIndex);
            var t = (a.timeInSeconds !== undefined && a.timeInSeconds !== null) ? a.timeInSeconds : comp.time;
            comp.saveFrameToPng(t, new File(a.outputPath));
            return { savedTo: a.outputPath, time: t };
        },

        getLayerAudioInfo: function (a) {
            var comp = getComp(a.compIndex);
            var layer = getLayer(comp, a.layerIndex);
            var info = { layer: layer.name, hasAudio: !!layer.hasAudio, audioEnabled: !!layer.audioEnabled };
            if (layer.source && layer.source.mainSource && layer.source.mainSource.file) {
                info.sourceFilePath = layer.source.mainSource.file.fsName;
            }
            return info;
        },

        // Blocks AE's main thread (and this whole bridge) until rendering
        // finishes — that's inherent to ExtendScript's renderQueue.render(),
        // not a bug here. The MCP server gives this op a much longer
        // per-call timeout to match. renderSettingsTemplate/outputModuleTemplate
        // reference templates pre-configured in AE's Render Queue UI — the
        // standard scripting mechanism for controlling format/codec/quality.
        renderComposition: function (a) {
            if (!a.outputPath) throw new Error("renderComposition requires 'outputPath'");
            var comp = getComp(a.compIndex);
            var rqItem = app.project.renderQueue.items.add(comp);
            if (a.renderSettingsTemplate) rqItem.applyTemplate(a.renderSettingsTemplate);
            var outputModule = rqItem.outputModule(1);
            if (a.outputModuleTemplate) outputModule.applyTemplate(a.outputModuleTemplate);
            outputModule.file = new File(a.outputPath);
            app.project.renderQueue.render();
            // Without an explicit outputModuleTemplate, AE's default output
            // format (commonly H.264/MP4) can silently override the
            // extension in outputPath — confirmed empirically: requesting
            // .avi and .png both actually saved as .mp4. requestedOutputPath
            // is what we asked for; actualOutputPath is AE's own File
            // object post-render, which reflects what really got used.
            var succeeded = (rqItem.status === RQItemStatus.DONE);
            var result = {
                comp: comp.name,
                requestedOutputPath: a.outputPath,
                actualOutputPath: outputModule.file ? outputModule.file.fsName : null,
                succeeded: succeeded,
                status: rqItem.status.toString()
            };
            if (!succeeded) {
                result.warning = "Render did not finish with status DONE (status=" + rqItem.status.toString() +
                    "). Check the file exists at actualOutputPath before assuming success.";
            }
            return result;
        },

        // Runs several ops in one request, in order, inside the single undo
        // group dispatch() already opened for "batch" itself — calls ops[]
        // directly rather than re-entering dispatch() to avoid nested undo
        // groups. A failed item is recorded but does not stop later items.
        batch: function (a) {
            if (!a.calls || !a.calls.length) throw new Error("batch requires a non-empty 'calls' array");
            var out = [];
            for (var i = 0; i < a.calls.length; i++) {
                var call = a.calls[i] || {};
                if (call.op === "batch") {
                    out.push({ ok: false, error: "Nested batch is not allowed" });
                    continue;
                }
                if (!ops.hasOwnProperty(call.op)) {
                    out.push({ ok: false, error: "Unknown op '" + call.op + "'" });
                    continue;
                }
                try {
                    out.push({ ok: true, result: ops[call.op](call.args || {}) });
                } catch (e) {
                    out.push({ ok: false, error: e.toString ? e.toString() : String(e) });
                }
            }
            return { results: out };
        },

        // Runs a caller-supplied script that can call ops.* in a loop, all
        // within ONE round trip and ONE undo group (dispatch() already wraps
        // every op call, including this one) — the performance win over
        // batch/individual calls for bulk structured construction (many
        // shapes/layers with the same pattern), since there's no per-element
        // network round trip.
        //
        // This is NOT a sandbox. new Function(...) (rather than eval) keeps
        // the script from seeing this bridge's own internal closure state
        // (client, poll, tryListen, etc.), but AE's real globals (app, etc.)
        // are still reachable in principle — the blocklist below exists to
        // catch accidental/careless use of file/system/network access, not
        // to stop a determined attempt to bypass it. The actual security
        // boundary against untrusted callers is the network layer (this
        // bridge should not be reachable by anyone you don't trust), not
        // this check.
        runMacro: function (a) {
            if (!a.script) throw new Error("runMacro requires 'script'");
            var script = a.script;
            var blocked = [
                "File(", "new File", "Folder(", "new Folder", "system.",
                "ExternalObject", "Socket(", "new Socket", "$.", "#include",
                "#script", "eval(", "app.quit", "app.project.save", "ScriptUI"
            ];
            for (var bi = 0; bi < blocked.length; bi++) {
                if (script.indexOf(blocked[bi]) !== -1) {
                    throw new Error(
                        "runMacro blocked: script contains disallowed pattern '" + blocked[bi] +
                        "'. runMacro may only call ops.* functions (plus plain control flow) — " +
                        "no file, system, network, or ScriptUI access."
                    );
                }
            }
            var results = [];
            var macroFn = new Function("ops", "results", script);
            macroFn(ops, results);
            return { ran: true, resultCount: results.length, results: results };
        }
    };

    function dispatch(op, args) {
        if (!ops.hasOwnProperty(op)) throw new Error("Unknown op '" + op + "'");
        app.beginUndoGroup("Claude: " + op);
        try {
            var result = ops[op](args || {});
            app.endUndoGroup();
            return result;
        } catch (e) {
            app.endUndoGroup();
            throw e;
        }
    }

    // ---------------------------------------------------------------------
    // Socket server: single client, line-delimited JSON, fully serialized.
    // ---------------------------------------------------------------------
    var listener = new Socket();
    var client = null;
    var listening = false;

    var lastListenAttempt = 0;
    var listenFailures = 0;

    function tryListen() {
        var now = new Date().getTime();
        if (lastListenAttempt && now - lastListenAttempt < 2000) return;
        lastListenAttempt = now;
        try {
            if (listener.listen(PORT)) {
                listening = true;
                listenFailures = 0;
                log("Listening on 127.0.0.1:" + PORT);
            } else {
                listenFailures++;
                if (listenFailures <= 3 || listenFailures % 100 === 0) {
                    log("listen() returned false on port " + PORT + " (attempt #" + listenFailures + ") — is another instance already running?");
                }
            }
        } catch (e) {
            log("listen() threw: " + e.toString() + " — check 'Allow Scripts to Write Files and Access Network' is enabled in AE Preferences.");
        }
    }

    // Temporary diagnostic verbosity — set to true to debug connection issues.
    var DEBUG = false;
    var tickCount = 0;
    var consecutiveReadErrors = 0;
    // Bytes received but not yet terminated by a newline. A request can arrive
    // split across several reads; only a complete line is ever parsed.
    var rxBuffer = "";

    function sendLine(text) {
        var prevTimeout = client.timeout;
        client.timeout = WRITE_TIMEOUT_SEC;
        try {
            if (!client.write(text + "\n")) {
                log("write() returned false for a " + text.length + "-char response");
            }
        } finally {
            client.timeout = prevTimeout;
        }
    }

    function handleLine(line) {
        var id = null;
        if (DEBUG) log("Received line (" + line.length + " chars): " + line);
        try {
            var req = jsonParse(line);
            id = req.id;
            if (DEBUG) log("Dispatching op=" + req.op + " id=" + id);
            var result = dispatch(req.op, req.args);
            var resp = jsonStringify({ id: id, ok: true, result: result });
            if (DEBUG) log("Writing success response for id=" + id + " (" + resp.length + " chars)");
            sendLine(resp);
            if (DEBUG) log("Wrote success response for id=" + id);
        } catch (e) {
            log("handleLine error for id=" + id + " (line " + line.length + " chars, starts " +
                line.substring(0, 60).replace(/[\r\n]/g, " ") + "): " + e.toString());
            try {
                sendLine(jsonStringify({
                    id: id,
                    ok: false,
                    error: { message: e.toString ? e.toString() : String(e), line: e.line, fileName: e.fileName }
                }));
                if (DEBUG) log("Wrote error response for id=" + id);
            } catch (e2) {
                log("Failed to write error response: " + e2.toString());
            }
        }
    }

    var polling = false;

    // Runs on a repeating scheduled task. A tick that AE blocks (e.g. a modal
    // dialog is open) is simply skipped and the next one runs normally; the
    // old one-shot re-arm died permanently the first time a tick was blocked.
    function poll() {
        if (polling) return;
        polling = true;
        try {
            pollOnce();
        } finally {
            polling = false;
        }
    }

    function pollOnce() {
        tickCount++;
        if (DEBUG && tickCount % 80 === 0) {
            log("heartbeat tick=" + tickCount + " listening=" + listening + " hasClient=" + !!client +
                (client ? (" connected=" + client.connected) : ""));
        }
        try {
            if (!listening) tryListen();

            // Always check for a new incoming connection, even if we think
            // we already have one. client.connected is not a reliable signal
            // that the old peer is gone (observed: it stays true forever
            // after the remote process exits), so a fresh incoming
            // connection is treated as proof the old one is stale and
            // replaces it. A well-behaved single MCP client never opens a
            // second connection while its first one is still alive, so this
            // is safe and fixes the "stuck forever after a reconnect" case.
            if (listening) {
                var incoming = listener.poll();
                if (incoming) {
                    if (client) {
                        log("New client arrived while old one still marked connected=" + client.connected + " — replacing it.");
                        try { client.close(); } catch (eClose) {}
                    }
                    client = incoming;
                    client.timeout = READ_TIMEOUT_SEC;
                    consecutiveReadErrors = 0;
                    rxBuffer = "";
                    log("Client connected");
                }
            }

            if (client) {
                if (!client.connected) {
                    log("Client disconnected");
                    client = null;
                    rxBuffer = "";
                } else {
                    drainLines();
                }
            }
        } catch (e) {
            log("poll() outer error: " + e.toString());
        }
    }

    // Reads whatever complete lines are already available. A short
    // client.timeout keeps a stalled read from freezing AE's main thread,
    // but that means readln() routinely times out with nothing to read —
    // that is the NORMAL idle case, not a disconnect, so it must not tear
    // down `client`. Only drop the client if the socket itself reports
    // disconnected. Logs the first few + every 200th read error (whatever
    // its actual message is) so a non-timeout failure mode is visible
    // instead of being silently swallowed forever.
    function drainLines() {
        for (;;) {
            var chunk;
            try {
                // read(n) returns whatever has arrived (up to n chars) within
                // the timeout. Unlike readln(), a partial line is kept in
                // rxBuffer instead of being handed to the parser as if it
                // were a whole message.
                chunk = client.read(65536);
                consecutiveReadErrors = 0;
            } catch (e) {
                consecutiveReadErrors++;
                if (consecutiveReadErrors <= 3 || consecutiveReadErrors % 200 === 0) {
                    log("read() error (#" + consecutiveReadErrors + "): " + e.toString() +
                        " connected=" + client.connected);
                }
                if (client && !client.connected) {
                    log("Client disconnected during read: " + e.toString());
                    client = null;
                    rxBuffer = "";
                }
                return;
            }
            if (chunk) rxBuffer += chunk;

            var nl;
            while ((nl = rxBuffer.indexOf("\n")) !== -1) {
                var line = rxBuffer.substring(0, nl);
                rxBuffer = rxBuffer.substring(nl + 1);
                if (line.length && line.charAt(line.length - 1) === "\r") {
                    line = line.substring(0, line.length - 1);
                }
                if (line) handleLine(line);
                if (!client) return;
            }

            if (rxBuffer.length > MAX_RX_CHARS) {
                log("Dropping " + rxBuffer.length + " buffered chars with no newline (over MAX_RX_CHARS)");
                rxBuffer = "";
            }
            if (!chunk) return;
        }
    }

    var bootstrapTaskId = null;
    var pollTaskId = null;

    // Fires once START_DELAY_MS after launch, cancels itself, then starts the
    // repeating poll task. The bootstrap is itself a repeating task so that if
    // its first tick is blocked by a modal dialog it just fires again later.
    function bootstrap() {
        if (pollTaskId !== null) return;
        if (bootstrapTaskId !== null) {
            try { app.cancelTask(bootstrapTaskId); } catch (e) {}
            bootstrapTaskId = null;
        }
        pollTaskId = app.scheduleTask("$.global.__claudeBridge.poll()", POLL_MS, true);
        log("polling started (every " + POLL_MS + "ms)");
    }

    tryListen();
    bootstrapTaskId = app.scheduleTask("$.global.__claudeBridge.bootstrap()", START_DELAY_MS, true);
    log("claude-bridge initialized (PORT=" + PORT + "), polling starts in " + START_DELAY_MS + "ms");

    return { poll: poll, bootstrap: bootstrap, dispatch: dispatch, PORT: PORT };
})();
