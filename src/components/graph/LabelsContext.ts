import { createContext, useContext } from 'react';

export const LabelsContext = createContext(false);
export const useLabelsVisible = () => useContext(LabelsContext);
