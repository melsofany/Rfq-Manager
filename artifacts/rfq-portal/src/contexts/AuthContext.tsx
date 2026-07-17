import { createContext, useContext, useState, useEffect, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getGetMeQueryKey, useGetMe, useLogout } from "@workspace/api-client-react";
import type { Employee } from "@workspace/api-client-react";

interface AuthContextValue {
  employee: Employee | null;
  isLoading: boolean;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue>({
  employee: null,
  isLoading: true,
  logout: () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useGetMe({ query: { retry: false, queryKey: getGetMeQueryKey() } });
  const logoutMutation = useLogout();

  const employee = data ?? null;

  const logout = () => {
    logoutMutation.mutate(undefined, {
      onSettled: () => {
        queryClient.clear();
        window.location.href = "/login";
      },
    });
  };

  return (
    <AuthContext.Provider value={{ employee, isLoading, logout }}>{children}</AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
