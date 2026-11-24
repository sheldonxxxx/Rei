// The in-memory copy of one vector set's vectors, for brute-force search: one Float32Array in entry order, kept in step
// with the table. Dot products over every vector are fast at this scale: 768 dims x 50,000 entries is about 150 MB and
// a query costs tens of milliseconds. Past roughly that many entries the index needs an approximate-search structure
// (or an on-disk one); the cache is the thing to replace.
export class VectorCache {
  readonly dims: number;
  #data: Float32Array;
  #ids: number[] = [];
  #slot = new Map<number, number>();

  constructor(dims: number, capacity = 1024) {
    this.dims = dims;
    this.#data = new Float32Array(capacity * dims);
  }

  get size(): number {
    return this.#ids.length;
  }
  has(id: number): boolean {
    return this.#slot.has(id);
  }

  /** Adds or replaces the vector of an entry. */
  set(id: number, vector: Float32Array): void {
    if (vector.length !== this.dims) throw new Error("vector has the wrong dimensions");
    let slot = this.#slot.get(id);
    if (slot === undefined) {
      slot = this.#ids.length;
      if ((slot + 1) * this.dims > this.#data.length) {
        const grown = new Float32Array(this.#data.length * 2);
        grown.set(this.#data);
        this.#data = grown;
      }
      this.#ids.push(id);
      this.#slot.set(id, slot);
    }
    this.#data.set(vector, slot * this.dims);
  }

  /** Removes an entry's vector (the last one moves into its place). */
  delete(id: number): void {
    const slot = this.#slot.get(id);
    if (slot === undefined) return;
    const last = this.#ids.length - 1;
    if (slot !== last) {
      const moved = this.#ids[last]!;
      this.#data.copyWithin(slot * this.dims, last * this.dims, (last + 1) * this.dims);
      this.#ids[slot] = moved;
      this.#slot.set(moved, slot);
    }
    // Zero the freed slot: nothing of a forgotten vector stays in memory longer than it must.
    this.#data.fill(0, last * this.dims, (last + 1) * this.dims);
    this.#ids.pop();
    this.#slot.delete(id);
  }

  clear(): void {
    this.#data.fill(0);
    this.#ids = [];
    this.#slot.clear();
  }

  /** The best `k` entries by cosine (vectors are unit length), best first. */
  search(query: Float32Array, k: number, accepts?: (id: number) => boolean): { id: number; cosine: number }[] {
    const { dims } = this;
    if (query.length !== dims) return [];
    const data = this.#data;
    const n = this.#ids.length;
    // A min-heap of the best k so far, as parallel arrays.
    const heapScore: number[] = [];
    const heapSlot: number[] = [];
    const down = (start: number) => {
      let i = start;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heapScore.length && heapScore[l]! < heapScore[m]!) m = l;
        if (r < heapScore.length && heapScore[r]! < heapScore[m]!) m = r;
        if (m === i) return;
        [heapScore[i], heapScore[m]] = [heapScore[m]!, heapScore[i]!];
        [heapSlot[i], heapSlot[m]] = [heapSlot[m]!, heapSlot[i]!];
        i = m;
      }
    };
    for (let s = 0; s < n; s++) {
      if (accepts && !accepts(this.#ids[s]!)) continue;
      let dot = 0;
      const o = s * dims;
      for (let j = 0; j < dims; j++) dot += data[o + j]! * query[j]!;
      if (heapScore.length < k) {
        heapScore.push(dot);
        heapSlot.push(s);
        let i = heapScore.length - 1;
        while (i > 0) {
          const p = (i - 1) >> 1;
          if (heapScore[p]! <= heapScore[i]!) break;
          [heapScore[p], heapScore[i]] = [heapScore[i]!, heapScore[p]!];
          [heapSlot[p], heapSlot[i]] = [heapSlot[i]!, heapSlot[p]!];
          i = p;
        }
      } else if (dot > heapScore[0]!) {
        heapScore[0] = dot;
        heapSlot[0] = s;
        down(0);
      }
    }
    return heapSlot
      .map((s, i) => ({ id: this.#ids[s]!, cosine: heapScore[i]! }))
      .sort((a, b) => b.cosine - a.cosine || a.id - b.id);
  }
}
