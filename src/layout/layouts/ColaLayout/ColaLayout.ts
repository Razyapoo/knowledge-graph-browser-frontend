import cytoscape, {Collection, Layouts, NodeSingular, Position} from "cytoscape";
import Layout from "../../Layout";
import clone from "clone";
import {Expansion} from "../../../graph/Expansion";
import Vue from "vue";
import {Node} from "../../../graph/Node";
import NodeGroup from "../../../graph/NodeGroup";
import NodeCommon from "../../../graph/NodeCommon";
import EdgeCommon from "../../../graph/EdgeCommon";
import {LayoutsCommonGroupSettings} from "../LayoutsCommon";

export interface ColaLayoutOptions extends LayoutsCommonGroupSettings {
    /**
     * If the layout should run after a user changes node position
     */
    doLayoutAfterReposition: boolean;

    /**
     * If set to true, only expanded nodes and nodes connected to them will be layouted
     */
    expansionOnlyThose: boolean;

    /**
     * Whether the layout computing should be animated.
     */
    animate: boolean;

    /**
     * Extra spacing around nodes
     */
    nodeSpacing: number;

    /**
     * Optimal edges length
     */
    edgeLength: number;
}

export default class ColaLayout extends Layout {
    public readonly supportsNodeLocking = true;
    public readonly supportsCompactMode = true;
    public readonly supportsHierarchicalView: boolean = true;

    private layoutAnimation: Layouts;
    private isActive: boolean = false;

    /**
     * Options for this layout which can be modified by a user
     */
    public options: ColaLayoutOptions = {
        doLayoutAfterReposition: true,
        expansionOnlyThose: false,
        animate: true,
        edgeLength: 200,
        nodeSpacing: 10,

        groupExpansion: true,
        expansionGroupLimit: 10,
    }

    activate() {
        this.isActive = true;
        // No need to do anything
    }

    deactivate() {
        this.isActive = false;
        this.onCompactMode(null, null);
        this.stopLayout();
    }

    onDrag(isStartNotEnd: boolean) {
        if (this.options.doLayoutAfterReposition && (!isStartNotEnd || (this.options.animate && !this.areaManipulator.layoutManager.currentLayout.constraintRulesLoaded))) {
            this.executeLayout(this.getCollectionToAnimate());
        }
    };

    onLockedChanged() {
        // Execute layout on everything
        this.executeLayout(this.getCollectionToAnimate());
    }

    /**
     * Preforms simple circle layout to make cola layout easier to find optimal positions
     * @param nodes nodes to position
     * @param position parent node position
     */
    private circleLayout(nodes: Node[], position: Position) {
        const distance = 100; // Minimal distance between nodes in px, ignoring bounding boxes

        let circNum = 0; // Actual circle number
        let phi = 0; // on circle position
        let circumference = 0; // Number of nodes on actual circle
        let i = 0; // Node number
        for (let node of nodes) {
            if (phi == circumference) {
                phi = 0;
                circNum++;
                // ORIGINAL EQUATION: [2 * PI * distance * circNum / distance]
                circumference = Math.min(nodes.length - i,  Math.floor(2 * Math.PI * circNum));
            }
            node.onMountPosition = [
                position.x + distance * circNum * Math.cos(2*Math.PI*phi/circumference),
                position.y + distance * circNum * Math.sin(2*Math.PI*phi/circumference)
            ];
            node.mounted = true;

            phi++; i++;
        }
    }

    async onExpansion(expansion: Expansion) {
        // First step, mount and position the nodes which are not mounted yet
        let notMountedNodes = expansion.nodes.filter(node => !node.mounted);
        let currentPosition = expansion.parentNode.selfOrGroup.element.element.position();
        let group: NodeGroup = null;
        let groupParent: Node = null;

        // Decides whether the nodes should be grouped
        if (notMountedNodes.length >= this.options.expansionGroupLimit && this.options.groupExpansion) {
            group = this.graph.createGroup();
            for (let node of notMountedNodes) {
                node.mounted = true;
                group.addNode(node);
                if (node.parent) {
                    if (!groupParent) {
                        groupParent = node.parent;
                    }
                    node.parent.getChildren.splice(
                        node.parent.getChildren.indexOf(node), 1
                    );
                }
            }
            
            if (groupParent) {
                group.parent = groupParent;
                if (!groupParent.children.find(child => child.identifier === group.identifier)) {
                    group.parent.getChildren.push(group);
                }
            }
            group.hierarchyLevel = group.nodes[0].hierarchyLevel;
            group.hierarchyGroup = group.nodes[0].hierarchyGroup;
            
            // By subtracting -1 we broke the possible line of nodes, allowing cola layout to work.
            group.onMountPosition = [currentPosition.x + 100, currentPosition.y - 1];
            group.mounted = true;
        } else {
            this.circleLayout(notMountedNodes, currentPosition);
        }

        // Wait for nodes to mount
        await Vue.nextTick();
        if (!this.isActive) return;

        let explicitlyFixed: Set<string> = new Set<string>();
        if (this.options.expansionOnlyThose) {
            // @ts-ignore bad types
            for (let node: NodeSingular of this.areaManipulator.cy.nodes()) {
                explicitlyFixed.add(node.id());
            }

            // Exclude expanded nodes
            expansion.nodes.forEach(node => explicitlyFixed.delete(node.selfOrGroup.identifier));

            // Exclude parent node
            explicitlyFixed.delete(expansion.parentNode.selfOrGroup.identifier);
        }

        this.executeLayout(this.areaManipulator.cy.elements(), explicitlyFixed);
    }

    async onGroupBroken(nodes: Node[], group: NodeGroup) {
        super.onGroupBroken(nodes, group);
        this.circleLayout(nodes, group.element?.element?.position() ?? this.areaManipulator.getCenterPosition());

        // Wait for nodes to mount
        await Vue.nextTick();
        if (!this.isActive) return;

        this.executeLayout(this.areaManipulator.cy.elements());
    }

    /**
     * Contains elements in the compact mode or null if the compact mode is turned off.
     * @non-reactive
     */
    private compactMode: cytoscape.Collection | null;

    private isCompactModeActive(): boolean {
        return !!this.compactMode;
    }

    /**
     * @inheritDoc
     */
    onCompactMode(nodes: NodeCommon[] | null, edges: EdgeCommon[] | null) {
        if (nodes === null && edges === null) {
            if (this.compactMode) {
                this.stopLayout();
                this.setAreaForCompact(false);
            }
            this.compactMode = null;
        } else {
            if (this.compactMode === null) {
                this.stopLayout();
                this.setAreaForCompact(true);
            }
            this.compactMode = this.areaManipulator.cy.collection();

            for (let node of nodes) {
                this.compactMode = this.compactMode.union(node.element.element);
            }

            for (let edge of edges) {
                this.compactMode = this.compactMode.union(edge.element.element);
            }

            // Run layout
            this.executeLayout(this.getCollectionToAnimate());
        }
    }

    private setAreaForCompact(isCompact: boolean) {
        this.areaManipulator.cy.userPanningEnabled(!isCompact);
        this.areaManipulator.cy.userZoomingEnabled(!isCompact);
        this.areaManipulator.cy.boxSelectionEnabled(!isCompact);
    }

    /**
     * Decides which elements should animate.
     *
     * If a compact mode is active, use its elements. Otherwise, use all elements.
     */
    private getCollectionToAnimate() {
        return this.compactMode ?? this.areaManipulator.cy.elements();
    }

    /**
     * For explicit layout call.
     */
    public run() {
        this.executeLayout(this.getCollectionToAnimate());
    }

    private stopLayout() {
        this.layoutAnimation?.stop();
    }

    /**
     * Starts cola layout.
     * @param collection Cytoscape collection of nodes and edges to be layouted. Other nodes keeps their original position
     *
     * Runs cytoscape-cola plugin.
     * @param fixed
     */
    private executeLayout(collection: Collection, fixed: Set<string> | undefined = undefined) {
        if (fixed === undefined) fixed = new Set<string>();

        this.stopLayout();

        this.layoutAnimation = collection.layout({
            name: "cola",
            // @ts-ignore there are no types for cola layout
            nodeDimensionsIncludeLabels: true,
            fit: false,
            centerGraph: false,
            animate: this.options.animate,
            extraLocked: (node: any) => fixed.has(node.id()) || (!this.isCompactModeActive() && node.scratch("_component").node.lockedForLayouts),
            nodeSpacing: this.options.nodeSpacing,
            edgeLength: this.options.edgeLength,
        });

        this.layoutAnimation.run();
    }

    saveToObject(): object {
        return clone(this.options);
    }

    restoreFromObject(object: any): void {
        this.options = {...this.options, ...object};
    }
}
