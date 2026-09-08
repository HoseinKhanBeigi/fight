/**
 * Ask / bid defense weakening from survival, depth, cancel, replenish,
 * wall-on-approach, and unreplaced consumption. No post-move labels.
 */

import { combineWeighted } from "./math.js";

export class DefenseWeakeningEngine {
  constructor(weights) {
    this.weights = weights;
  }

  score(features) {
    return combineWeighted(this.weights, features);
  }
}
