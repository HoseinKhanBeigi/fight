/**
 * Liquidity-vacuum / book-preparation scores.
 * Uses only current book + passive-flow features (no price displacement).
 */

import { combineWeighted } from "./math.js";

export class BookPreparationEngine {
  constructor(weights) {
    this.weights = weights;
  }

  /**
   * @param {object} features 0–100 normalized components
   */
  score(features) {
    return combineWeighted(this.weights, features);
  }
}
