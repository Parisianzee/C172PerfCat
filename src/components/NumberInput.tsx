import React from 'react';


interface Props extends React.InputHTMLAttributes<HTMLInputElement> {
label: string;
suffix?: string;
error?: string;
}


export default function NumberInput({ label, suffix, error, ...rest }: Props) {
return (
<label className="block">
<span className="block text-sm font-medium text-gray-700 mb-1">{label}</span>
<div className="relative">
<input
type="number"
className={`w-full rounded-xl border px-3 py-2 pr-12 outline-none focus:ring-2 focus:ring-blue-500 ${error ? 'border-red-500' : 'border-gray-300'}`}
{...rest}
/>
{suffix && (
<span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm">{suffix}</span>
)}
</div>
{error && <span className="text-xs text-red-600">{error}</span>}
</label>
);
}