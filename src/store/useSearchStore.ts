import { create } from 'zustand';
import { MediaItem, MediaType, SearchPhase } from '../types/types';

interface SearchState {
  query: string;
  results: MediaItem[];
  loading: boolean;
  searchLoading: boolean;
  trendingLoading: boolean;
  error: string | null;
  selectedType: MediaType | 'All';
  isTrending: boolean;
  currentSearchId: string | null;
  searchPhase: SearchPhase | null;

  setQuery: (query: string) => void;
  setResults: (results: MediaItem[] | ((prev: MediaItem[]) => MediaItem[])) => void;
  setSearchLoading: (loading: boolean) => void;
  setTrendingLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  setSelectedType: (type: MediaType | 'All') => void;
  setIsTrending: (isTrending: boolean) => void;
  setCurrentSearchId: (id: string | null) => void;
  setSearchPhase: (phase: SearchPhase | null) => void;
  resetSearch: () => void;
}

export const useSearchStore = create<SearchState>((set) => ({
  query: '',
  results: [],
  loading: false, // Derived or combined state can be handled in components or here if needed, but for now we keep primitives
  searchLoading: false,
  trendingLoading: false,
  error: null,
  selectedType: 'All',
  isTrending: true,
  currentSearchId: null,
  searchPhase: null,

  setQuery: (query) => set({ query }),
  setResults: (results) => set((state) => ({
    results: typeof results === 'function' ? results(state.results) : results
  })),
  setSearchLoading: (searchLoading) => set({ searchLoading }),
  setTrendingLoading: (trendingLoading) => set({ trendingLoading }),
  setError: (error) => set({ error }),
  setSelectedType: (selectedType) => set({ selectedType }),
  setIsTrending: (isTrending) => set({ isTrending }),
  setCurrentSearchId: (currentSearchId) => set({ currentSearchId }),
  setSearchPhase: (searchPhase) => set({ searchPhase }),
  resetSearch: () => set({
    query: '',
    results: [],
    searchLoading: false,
    trendingLoading: false,
    error: null,
    isTrending: true,
    currentSearchId: null,
    searchPhase: null
  }),
}));
