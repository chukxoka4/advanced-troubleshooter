<?php

const ORIGIN = [0, 0];

function distance($a, $b) {
    return sqrt(pow($a[0] - $b[0], 2) + pow($a[1] - $b[1], 2));
}

class Vec {
    public function __construct(public float $x, public float $y) {}

    public function length(): float {
        return sqrt($this->x * $this->x + $this->y * $this->y);
    }
}
