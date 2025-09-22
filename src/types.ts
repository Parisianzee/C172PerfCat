export type MaybeNum = number | null;


export interface WeightTable {
weight_lb: number;
speeds_kias: { liftoff: number; at_50ft: number };
ground_roll_ft: (MaybeNum)[][]; // rows: PA grid, cols: temp grid
to_clear_50ft_ft: (MaybeNum)[][]; // same shape
}


export interface DataSchema {
schema_version: string;
aircraft: string;
poh_edition_year: number;
units: {
weight: string;
temperature: string;
pressure_altitude: string;
speed: string;
distance: string;
};
assumptions: {
config: string;
runway: string;
wind: string;
technique: string;
};
adjustments: {
headwind_per_9kt: number; // -0.10
tailwind_up_to_10kt: number; // +0.10
dry_grass_from_ground_roll: number; // +0.15
notes: string[];
};
grid: {
pressure_altitudes_ft: (number | 'SL')[]; // we'll map 'SL' to 0 for math
temperatures_c: number[];
weights: WeightTable[];
};
}