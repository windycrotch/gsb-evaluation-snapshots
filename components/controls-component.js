layout.registerComponent( 'controlsComponent', function(container, componentState){
    container.getElement().html(
        `<div class="controls" id="controls">
            <button type='button' class='btn btn-sm' onclick='setControlMode(CONTROLMODE.move)'>Move</button>
            <button type='button' class='btn btn-sm' onclick='setControlMode(CONTROLMODE.rotate)'>Rotate</button><br>
            <hr>
            <div>Current Time: <span id='current-time'>0</span></div>
            <button type='button' class='btn btn-sm' onclick='play()'>Play</button>
            <button type='button' class='btn btn-sm' onclick='pause()'>Pause</button>
            <button type='button' class='btn btn-sm' onclick='stop()'>Stop</button><br>
            <button type='button' class='btn btn-sm' onclick='seekTimeInput()'>Seek To Time:</button>
            <input type='number' name='seek-to-time' id='seek-to-time' value='0' placeholder='time'><br>
            <hr>
            <div>
                <span>Set Keyframe For:</span>
                <select id='keyframe-what-nodes'>
                    <option value='all-nodes'>All Nodes</option>
                    <option value='selected-and-children'>Selected And Children</option>
                    <option value='selected-node'>Selected</option>
                </select>
            </div>
            <label for='kf-position'>Position:</label>
            <input type='checkbox' name='kf-position' id='kf-position' checked='true'><br>
            <label for='kf-rotation'>Rotation:</label>
            <input type='checkbox' name='kf-rotation' id='kf-rotation' checked='true'><br>
            <label for='kf-scale'>Scale:</label>
            <input type='checkbox' name='kf-scale' id='kf-scale' checked='true'><br>
            <label for='kf-visible'>Visibility:</label>
            <input type='checkbox' name='kf-visible' id='kf-visible' checked='true'><br>

            <button type='button' class='btn btn-sm' onclick='setKeyframe()'>Set Keyframe</button><br>
            <button type='button' class='btn btn-sm' onclick='copyKeyframe()'>Copy Keyframe To Time</button>
            <input type='number' name='copy-to-time' id='copy-to-time' placeholder='time'><br>
            <button type='button' class='btn btn-sm' onclick='shiftKeyframes()'>Shift Keyframes</button>
            <input type='number' name='shift-by-time' id='shift-by-time' placeholder='time'><br>
            <button type='button' class='btn btn-sm' onclick='removeKeyframe()'>Remove Keyframe</button><br>
            <button type='button' class='btn btn-sm' onclick='seekNext()'>Seek Next Keyframe</button><br>
            <button type='button' class='btn btn-sm' onclick='seekPrevious()'>Seek Previous Keyframe</button><br>
            <hr>
            <div>Key Camera: <span id='key-camera'>default camera</span></div>
            <button type='button' class='btn btn-sm' onclick='setKeyframeCamera()'>Set Camera</button>
            <select id='keyframe-camera'></select><br>
            <button type='button' class='btn btn-sm' onclick='seekNextKC()'>Seek Next Key Camera</button><br>
            <button type='button' class='btn btn-sm' onclick='seekPreviousKC()'>Seek Previous Key Camera</button><br>
        </div>`);
});

function setControlMode(mode) {
    controlMode = mode;
    var treeNode = $('#scene-tree').tree('getSelectedNode');
    var node = findNode(pcx, treeNode.id);
    if (node == false)
        return;
    node.threeObject.children.forEach(function(child) {
        if (child.axesGrips)
            child.visible = mode == CONTROLMODE.move;
        if (child.rotGrips)
            child.visible = mode == CONTROLMODE.rotate;
    });
    viewportsNeedRender();
}

function setKeyframe() {
    var time = timeline.getCustomTime('playhead').getTime();
    var treeNode = $('#scene-tree').tree('getSelectedNode');
    var selectedNode = null;
    var kfWhatNodes = $('#keyframe-what-nodes').val();
    var nodes = [];
    if (kfWhatNodes == 'all-nodes') {
        traverseTree(pcx, function(node) {
            nodes.push(node);
        });
    }
    else if (kfWhatNodes == 'selected-and-children') {
        selectedNode = findNode(pcx, treeNode.id)
        traverseTree(pcx, function(node) {
            nodes.push(node);
        }, selectedNode);
    }
    else if (kfWhatNodes == 'selected-node') {
        selectedNode = findNode(pcx, treeNode.id);
        nodes.push(selectedNode);
    }
    
    if (treeNode == false && kfWhatNodes != 'all-nodes') {
        alert('Select a node to set a keyframe');
        return;
    }
    var existing = getKeyframe(pcx, time);
    var nodesData = [];
    var nodeNames = '"';
    var kfPosition = $('#kf-position').prop('checked');
    var kfRotation = $('#kf-rotation').prop('checked');
    var kfScale = $('#kf-scale').prop('checked');
    var kfVisible = $('#kf-visible').prop('checked');
    nodes.forEach(function(node) {
        if (node.id == 0)
            return;
        nodeNames += node.name + '" ';
        var nodeKF = getNodeData(node, kfPosition, kfRotation, kfScale, kfVisible);
        nodesData.push(nodeKF);
    });
    if (existing == null) {
        var kf = {
            time: time,
            nodes: nodesData
        };
        pcx.keyframes.push(kf);
        log('Created new keyframe at ' + time + ' with data for nodes ' + nodeNames);
    }
    else {
        nodesData.forEach(function(data) {
            var existingData = getKeyframeData(existing, data.id);
            if (existingData) {
                if (kfPosition) {
                    existingData.pos = data.pos;
                }
                if (kfRotation) {
                    existingData.rot = data.rot;
                }
                if (kfScale) {
                    existingData.scale = data.scale;
                }
                if (kfVisible) {
                    existingData.vis = data.vis;
                }
            }
            else {
                existing.nodes.push(data);
            }
        });
        log('Updated keyframe data for nodes ' + nodeNames);
    }
    updateTimeline();
}

function shiftKeyframes() {
    var shiftInput = $('#shift-by-time').val();
    var shiftInputStr = (shiftInput === undefined || shiftInput === null) ? '' : String(shiftInput).trim();
    if (!/^[+-]?\d+$/.test(shiftInputStr)) {
        alert('Shift time must be a whole number. No keyframes were shifted.');
        log('Shift keyframes cancelled: "' + shiftInputStr + '" is not a valid integer', 'warning');
        return;
    }
    var shiftBy = parseInt(shiftInputStr, 10);
    if (shiftBy == 0) {
        log('Shift keyframes by 0: nothing to move');
        return;
    }
    var kfWhatNodes = $('#keyframe-what-nodes').val();
    var kfPosition = $('#kf-position').prop('checked');
    var kfRotation = $('#kf-rotation').prop('checked');
    var kfScale = $('#kf-scale').prop('checked');
    var kfVisible = $('#kf-visible').prop('checked');
    var treeNode = $('#scene-tree').tree('getSelectedNode');
    var selectedNode = null;
    if (treeNode != false)
        selectedNode = findNode(pcx, treeNode.id);
    if (kfWhatNodes != 'all-nodes' && selectedNode == null) {
        alert('Select a node to shift keyframes');
        return;
    }
    var targetNodes = [];
    if (kfWhatNodes == 'all-nodes') {
        traverseTree(pcx, function(node) {
            if (node.id != 0)
                targetNodes.push(node);
        });
    }
    else if (kfWhatNodes == 'selected-and-children') {
        traverseTree(pcx, function(node) {
            if (node.id != 0)
                targetNodes.push(node);
        }, selectedNode);
    }
    else if (selectedNode.id != 0) {
        targetNodes.push(selectedNode);
    }
    if (targetNodes.length == 0) {
        alert('Select a node to shift keyframes');
        return;
    }

    var cloneValue = function(value) {
        return JSON.parse(JSON.stringify(value));
    };
    var nodeNames = [];
    var moves = [];
    pcx.keyframes.forEach(function(kf) {
        if (!kf.nodes)
            return;
        var movedData = [];
        targetNodes.forEach(function(node) {
            var data = getKeyframeData(kf, node.id);
            if (data == null)
                return;
            var newData = {id: node.id};
            var hasData = false;
            if (kfPosition && data.pos !== undefined) {
                newData.pos = cloneValue(data.pos);
                hasData = true;
            }
            if (kfRotation && data.rot !== undefined) {
                newData.rot = cloneValue(data.rot);
                hasData = true;
            }
            if (kfScale && data.scale !== undefined) {
                newData.scale = cloneValue(data.scale);
                hasData = true;
            }
            if (kfVisible && data.vis !== undefined) {
                newData.vis = data.vis;
                hasData = true;
            }
            if (!hasData)
                return;
            if (nodeNames.indexOf(node.name) == -1)
                nodeNames.push(node.name);
            movedData.push({nodeId: node.id, source: data, data: newData});
        });
        if (movedData.length == 0)
            return;
        moves.push({
            kf: kf,
            oldTime: kf.time,
            newTime: kf.time + shiftBy,
            movedData: movedData
        });
    });

    if (moves.length == 0) {
        log('No keyframe data for the selected nodes to shift', 'warning');
        return;
    }

    // Out-of-range destinations: below 0 the data is dropped, past the length it is kept with a warning.
    moves.forEach(function(move) {
        move.removed = move.newTime < 0;
        if (move.removed) {
            log('The keyframe at time ' + move.oldTime + ' was moved to a negative time and was removed', 'warning');
        }
        else if (move.newTime >= pcx.settings.length) {
            log('The keyframe at time ' + move.oldTime + ' was moved to a time past the animation length', 'warning');
        }
    });

    // Snapshot then strip the moved data from its source keyframe so no keyframe is moved twice.
    moves.forEach(function(move) {
        move.movedData.forEach(function(entry) {
            if (entry.data.pos !== undefined)
                entry.source.pos = undefined;
            if (entry.data.rot !== undefined)
                entry.source.rot = undefined;
            if (entry.data.scale !== undefined)
                entry.source.scale = undefined;
            if (entry.data.vis !== undefined)
                entry.source.vis = undefined;
        });
    });

    // Drop node entries emptied by the strip, then keyframes that have nothing left.
    var affectedKeyframes = [];
    moves.forEach(function(move) {
        if (affectedKeyframes.indexOf(move.kf) == -1)
            affectedKeyframes.push(move.kf);
        for (var i = 0; i < move.kf.nodes.length; i++) {
            var nodeData = move.kf.nodes[i];
            if (nodeData.pos === undefined && nodeData.rot === undefined && nodeData.scale === undefined && nodeData.vis === undefined) {
                move.kf.nodes.splice(i, 1);
                i--;
            }
        }
    });
    affectedKeyframes.forEach(function(kf) {
        if (kf.nodes.length == 0 && kf.cameraId === undefined) {
            var index = pcx.keyframes.indexOf(kf);
            if (index != -1)
                pcx.keyframes.splice(index, 1);
        }
    });

    // Move the snapshotted data to its new time, merging into any keyframe already there.
    moves.forEach(function(move) {
        if (move.removed)
            return;
        var destKF = getKeyframe(pcx, move.newTime);
        if (destKF == null) {
            destKF = {time: move.newTime, nodes: []};
            pcx.keyframes.push(destKF);
        }
        move.movedData.forEach(function(entry) {
            var destData = getKeyframeData(destKF, entry.nodeId);
            if (destData == null) {
                destData = {id: entry.nodeId};
                destKF.nodes.push(destData);
            }
            if (entry.data.pos !== undefined)
                destData.pos = entry.data.pos;
            if (entry.data.rot !== undefined)
                destData.rot = entry.data.rot;
            if (entry.data.scale !== undefined)
                destData.scale = entry.data.scale;
            if (entry.data.vis !== undefined)
                destData.vis = entry.data.vis;
        });
    });

    var nodeNamesStr = '"';
    nodeNames.forEach(function(name) {
        nodeNamesStr += name + '" ';
    });
    log('Shifted time for data for nodes ' + nodeNamesStr);
    seekTime(pcx.time);
    updateTimeline();
    viewportsNeedRender();
}

function getNodeData(node, kfPosition, kfRotation, kfScale, kfVisible) {
    var nodeKF = {
        id: node.id,
    };
    if (kfPosition) {
        nodeKF.pos = {
            x: parseFloat(node.threeObject.position.x.toFixed(precision)), 
            y: parseFloat(node.threeObject.position.y.toFixed(precision)), 
            z: parseFloat(node.threeObject.position.z.toFixed(precision))
        };
    }
    if (kfRotation) {
        nodeKF.rot = {
            x: parseFloat(node.threeObject.quaternion.x.toFixed(precision)), 
            y: parseFloat(node.threeObject.quaternion.y.toFixed(precision)), 
            z: parseFloat(node.threeObject.quaternion.z.toFixed(precision)), 
            w: parseFloat(node.threeObject.quaternion.w.toFixed(precision))
        };
    }
    if (kfScale) {
        nodeKF.scale = {
            x: parseFloat(node.threeObject.scale.x.toFixed(precision)),
            y: parseFloat(node.threeObject.scale.y.toFixed(precision)),
            z: parseFloat(node.threeObject.scale.z.toFixed(precision))
        };
    }
    if (kfVisible) {
        var vis = null;
        node.threeObject.children.forEach(function(child) {
            if (child.model) {
                vis = child.vis;
            }
        });
        if (vis != null && vis !== undefined)
            nodeKF.vis = vis;
    }
    return nodeKF;
}

function copyKeyframe() {
    var time = timeline.getCustomTime('playhead').getTime();
    var kf = getKeyframe(pcx, time);
    if (kf == null) {
        alert('No keyframe at current time. Seek to a time with a keyframe to copy');
        return;
    }
    var copyTime = parseInt($('#copy-to-time').val());
    var kfWhatNodes = $('#keyframe-what-nodes').val();
    var kfPosition = $('#kf-position').prop('checked');
    var kfRotation = $('#kf-rotation').prop('checked');
    var kfScale = $('#kf-scale').prop('checked');
    var kfVisible = $('#kf-visible').prop('checked');
    var kfExisting = getKeyframe(pcx, copyTime);
    if (kfExisting == null) {
        kfExisting = {
            time: copyTime,
            nodes: []
        };
        pcx.keyframes.push(kfExisting);
    }
    var kfNewNodeData = [];
    var treeNode = $('#scene-tree').tree('getSelectedNode');
    var selectedNode = null;
    if (treeNode != false)
        selectedNode = findNode(pcx, treeNode.id);
    kf.nodes.forEach(function(node) {
        if (kfWhatNodes == 'selected-and-children') {
            var skip = true;
            traverseTree(pcx, function(other) {
                if (other.id == node.id)
                    skip = false;
            }, selectedNode);
            if (skip)
                return;
        }
        else if (kfWhatNodes == 'selected-node') {
            if (node.id != treeNode.id || node.id == 0)
                return;
        }
        var nodeData = getKeyframeData(kf, node.id);
        var existingData = null;
        kfExisting.nodes.forEach(function(existingNode) {
            if (nodeData.id == existingNode.id)
                existingData = existingNode;
        });
        if (existingData) {
            if (nodeData.pos && kfPosition)
                existingData.pos = nodeData.pos;
            if (nodeData.rot && kfRotation)
                existingData.rot = nodeData.rot;
            if (nodeData.scale && kfScale)
                existingData.scale = nodeData.scale;
            if (nodeData.vis && kfVisible)
                existingData.vis = nodeData.vis;
        }
        else {
            var newData = {id: node.id};
            if (kfPosition)
                newData.pos = nodeData.pos;
            if (kfRotation)
                newData.rot = nodeData.rot;
            if (kfScale)
                newData.scale = nodeData.scale;
            if (kfVisible)
                newData.vis = nodeData.vis;
            if (kfPosition || kfRotation || kfScale)
                kfNewNodeData.push(newData);
        }
    });
    kfNewNodeData.forEach(function(newData) {
        kfExisting.nodes.push(newData);
    });
    
    updateTimeline();
    viewportsNeedRender();
}

function removeKeyframe() {
    var time = timeline.getCustomTime('playhead').getTime();
    var kf = getKeyframe(pcx, time);
    if (kf == null) {
        alert('No keyframe at current time. Seek to a time with a keyframe to remove it');
        return;
    }
    var kfWhatNodes = $('#keyframe-what-nodes').val();
    var kfPosition = $('#kf-position').prop('checked');
    var kfRotation = $('#kf-rotation').prop('checked');
    var kfScale = $('#kf-scale').prop('checked');
    var kfVisible = $('#kf-visible').prop('checked');
    var treeNode = $('#scene-tree').tree('getSelectedNode');
    var selectedNode = null;
    if (treeNode != false)
        selectedNode = findNode(pcx, treeNode.id);
    if (kfWhatNodes != 'all-nodes' && selectedNode == null) {
        alert('Select a node to remove a keyframe');
        return;
    }
    var nodeNames = '"';
    kf.nodes.forEach(function(node) {
        if (kfWhatNodes == 'selected-and-children') {
            var skip = true;
            traverseTree(pcx, function(other) {
                if (other.id == node.id)
                    skip = false;
            }, selectedNode);
            if (skip)
                return;
        }
        else if (kfWhatNodes == 'selected-node') {
            if (node.id != treeNode.id || node.id == 0)
                return;
        }
        var sceneNode = findNode(pcx, node.id);
        nodeNames += sceneNode.name + '" ';
        if (kfPosition)
            node.pos = undefined;
        if (kfRotation)
            node.rot = undefined;
        if (kfScale)
            node.scale = undefined;
        if (kfVisible)
            node.vis = undefined;
    });
    cleanKeyframes(nodeNames);
    seekTime(time);
    updateProperties();
    updateTimeline();
}

function cleanKeyframes(nodeNames) {
    for (var i = 0; i < pcx.keyframes.length; i++) {
        var kf = pcx.keyframes[i];
        for (var n = 0; n < kf.nodes.length; n++) {
            if (kf.nodes[n].pos === undefined && kf.nodes[n].rot === undefined && kf.nodes[n].scale == undefined && kf.nodes[n].vis == undefined) {
                log('Removed data from keyframe at ' + kf.time + ' for nodes ' + nodeNames);
                kf.nodes.splice(n, 1);
                n--;
            }
        }
    }
    for (var i = 0; i < pcx.keyframes.length; i++) {
        if (pcx.keyframes[i].nodes.length == 0) {
            log('Removed keyframe at ' + pcx.keyframes[i].time);
            pcx.keyframes.splice(i, 1);
            i--;
        }
    }
}

function seekNextPreviousKC(next) {
    var time = timeline.getCustomTime('playhead').getTime();
    var newTime = -1;
    pcx.keyframes.forEach(function(kf) {
        if (kf.cameraId !== undefined) {
            if ((next && kf.time > time) || (!next && kf.time < time)) {
                if (newTime == -1)
                    newTime = kf.time;
                else if ((next && kf.time < newTime) || (!next && kf.time > newTime))
                    newTime = kf.time;
            }
        }
    });
    if (newTime != -1) {
        seekTime(newTime);
        updateProperties();
    }
}

function seekNextPrevious(next) {
    var time = timeline.getCustomTime('playhead').getTime();
    var newTime = -1;
    var kfWhatNodes = $('#keyframe-what-nodes').val();
    var kfPosition = $('#kf-position').prop('checked');
    var kfRotation = $('#kf-rotation').prop('checked');
    var kfScale = $('#kf-scale').prop('checked');
    var kfVisible = $('#kf-visible').prop('checked');
    var treeNode = $('#scene-tree').tree('getSelectedNode');
    var selectedNode = null;
    if (treeNode != false)
        selectedNode = findNode(pcx, treeNode.id);
    pcx.keyframes.forEach(function(kf) {
        if (!kf.nodes)
            return;
        kf.nodes.forEach(function(nodeData) {
            var skip = true;
            if (kfWhatNodes == 'all-nodes')
                skip = false;
            else if (kfWhatNodes == 'selected-and-children') {
                traverseTree(pcx, function(other) {
                    if (other.id == nodeData.id)
                        skip = false;
                }, selectedNode);
            }
            else if (nodeData.id == selectedNode.id)
                skip = false;
            if (skip)
                return;
            
            if ((nodeData.pos && kfPosition) || (nodeData.rot && kfRotation) || (nodeData.scale && kfScale) || nodeData.vis !== undefined && kfVisible) {
                if ((next && kf.time > time) || (!next && kf.time < time)) {
                    if (newTime == -1)
                        newTime = kf.time;
                    else if ((next && kf.time < newTime) || (!next && kf.time > newTime))
                        newTime = kf.time;
                }
            }
        });
    });
    if (newTime != -1) {
        seekTime(newTime);
        updateProperties();
    }
}

function seekNext() {
    seekNextPrevious(true);
}

function seekPrevious() {
    seekNextPrevious(false);
}

function seekNextKC() {
    seekNextPreviousKC(true);
}

function seekPreviousKC() {
    seekNextPreviousKC(false);
}

function seekTimeInput() {
    var time = parseInt($('#seek-to-time').val());
    if (time < 0 || time > pcx.settings.length - 1) {
        alert('Seek to time must be between 0 and ' + (pcx.settings.length - 1));
        return;
    }
    seekTime(time);
    updateProperties();
}

function play() {
    if (playState == PLAY.play)
        return;
    playState = PLAY.play;
    pcx.timerId = setInterval(function() {
        var time = timeline.getCustomTime('playhead').getTime();
        seekTime(time, true);
        time = time + 1;
        if (time > pcx.settings.length - 1) {
            if (pcx.settings.loop) {
                time = 0;
            }
            else {
                playState = PLAY.stop;
                clearInterval(pcx.timerId);
                pcx.timerId = -1;
                return;
            }
        }
        
        timeline.setCustomTime(new Date(time), 'playhead');
    }, 1000 / pcx.settings.framerate);
}

function pause() {
    playState = PLAY.stop;
    if (pcx.timerId != -1) {
        clearInterval(pcx.timerId);
        pcx.timerId = -1;
    }
}

function stop() {
    pause();
    seekTime(0);
    updateProperties();
}

function setKeyframeCamera() {
    var time = timeline.getCustomTime('playhead').getTime();
    var cameraName = $('#keyframe-camera').val();
    var cameraNode = findNodeByName(cameraName);
    var kf = getKeyframe(pcx, time);
    if (kf == null) {
        var newKF = {
            time: time,
            nodes: [],
            cameraId: cameraNode.cameraId
        }
        pcx.keyframes.push(newKF);
        log('Created new keyframe with camera ' + cameraName + ' at time ' + time);
    }
    else {
        kf.cameraId = cameraNode.cameraId;
        log('Updated camera to "' + cameraName + '" at time ' + time);
    }
    $('#key-camera').text(cameraName);
    updateTimeline();
    viewportsNeedRender();
}
