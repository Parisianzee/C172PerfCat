import React from 'react';


interface Option<T = string | number> {
label: string;
value: T;
}


interface Props<T = string | number> extends React.SelectHTMLAttributes<HTMLSelectElement> {
label: string;
options: Option<T>[];
}


export default function Select<T>({ label, options, ...rest }: Props<T>) {
return (
<label className="block">
<span className="block text-sm font-medium text-gray-700 mb-1">{label}</span>
<select
className="w-full rounded-xl border px-3 py-2 outline-none focus:ring-2 focus:ring-blue-500 border-gray-300 bg-white"
{...rest as any}
>
{options.map((o, i) => (
<option key={i} value={o.value as any}>{o.label}</option>
))}
</select>
</label>
);
}