import React from "react";

/**
 * GraphPlaceholder — the home view's main panel. Deliberately isolated: the
 * real knowledge graph (territory map, domain clusters, frontier) is a
 * separate research/planning phase and will replace ONLY this component.
 */
export function GraphPlaceholder() {
	return (
		<div className="graph-placeholder">
			<div className="graph-placeholder-inner">
				<div className="graph-placeholder-title">Knowledge graph</div>
				<div className="graph-placeholder-sub">
					Coming in phase 2 — the territory map, repairs, and unlock views.
				</div>
			</div>
		</div>
	);
}
