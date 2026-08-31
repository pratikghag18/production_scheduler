export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      assignments: {
        Row: {
          area_override: boolean
          area_override_reason: string | null
          created_at: string
          created_by: string | null
          efficiency: number
          eligibility_override: boolean
          id: string
          node_id: string
          operator_display_name: string | null
          operator_id: string | null
          org_id: string
          override_reason: string | null
          product_color_token: string | null
          product_id: string | null
          product_name: string | null
          product_sku: string | null
          run_id: string | null
          status: string
          target_qty: number | null
          target_unit: string | null
          timerange: unknown
          updated_at: string
        }
        Insert: {
          area_override?: boolean
          area_override_reason?: string | null
          created_at?: string
          created_by?: string | null
          efficiency?: number
          eligibility_override?: boolean
          id?: string
          node_id: string
          operator_display_name?: string | null
          operator_id?: string | null
          org_id: string
          override_reason?: string | null
          product_color_token?: string | null
          product_id?: string | null
          product_name?: string | null
          product_sku?: string | null
          run_id?: string | null
          status?: string
          target_qty?: number | null
          target_unit?: string | null
          timerange: unknown
          updated_at?: string
        }
        Update: {
          area_override?: boolean
          area_override_reason?: string | null
          created_at?: string
          created_by?: string | null
          efficiency?: number
          eligibility_override?: boolean
          id?: string
          node_id?: string
          operator_display_name?: string | null
          operator_id?: string | null
          org_id?: string
          override_reason?: string | null
          product_color_token?: string | null
          product_id?: string | null
          product_name?: string | null
          product_sku?: string | null
          run_id?: string | null
          status?: string
          target_qty?: number | null
          target_unit?: string | null
          timerange?: unknown
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "assignments_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assignments_org_id_node_id_fkey"
            columns: ["org_id", "node_id"]
            isOneToOne: false
            referencedRelation: "nodes"
            referencedColumns: ["org_id", "id"]
          },
          {
            foreignKeyName: "assignments_org_id_operator_id_fkey"
            columns: ["org_id", "operator_id"]
            isOneToOne: false
            referencedRelation: "operators"
            referencedColumns: ["org_id", "id"]
          },
          {
            foreignKeyName: "assignments_org_id_product_id_fkey"
            columns: ["org_id", "product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["org_id", "id"]
          },
          {
            foreignKeyName: "assignments_org_id_run_id_fkey"
            columns: ["org_id", "run_id"]
            isOneToOne: false
            referencedRelation: "runs"
            referencedColumns: ["org_id", "id"]
          },
        ]
      }
      audit_log: {
        Row: {
          action: string
          actor_id: string | null
          after: Json | null
          at: string
          before: Json | null
          id: number
          org_id: string
          row_id: string
          table_name: string
        }
        Insert: {
          action: string
          actor_id?: string | null
          after?: Json | null
          at?: string
          before?: Json | null
          id?: never
          org_id: string
          row_id: string
          table_name: string
        }
        Update: {
          action?: string
          actor_id?: string | null
          after?: Json | null
          at?: string
          before?: Json | null
          id?: never
          org_id?: string
          row_id?: string
          table_name?: string
        }
        Relationships: [
          {
            foreignKeyName: "audit_log_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
      hierarchy_levels: {
        Row: {
          id: string
          is_schedulable: boolean
          name: string
          org_id: string
          position: number
          template_id: string
        }
        Insert: {
          id?: string
          is_schedulable?: boolean
          name: string
          org_id: string
          position: number
          template_id: string
        }
        Update: {
          id?: string
          is_schedulable?: boolean
          name?: string
          org_id?: string
          position?: number
          template_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "hierarchy_levels_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hierarchy_levels_org_template_fkey"
            columns: ["org_id", "template_id"]
            isOneToOne: false
            referencedRelation: "hierarchy_templates"
            referencedColumns: ["org_id", "id"]
          },
        ]
      }
      hierarchy_templates: {
        Row: {
          id: string
          name: string
          org_id: string
          site_node_id: string | null
        }
        Insert: {
          id?: string
          name: string
          org_id: string
          site_node_id?: string | null
        }
        Update: {
          id?: string
          name?: string
          org_id?: string
          site_node_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "hierarchy_templates_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hierarchy_templates_org_id_site_node_id_fkey"
            columns: ["org_id", "site_node_id"]
            isOneToOne: false
            referencedRelation: "nodes"
            referencedColumns: ["org_id", "id"]
          },
        ]
      }
      node_shift_templates: {
        Row: {
          node_id: string
          org_id: string
          template_id: string
          updated_at: string
        }
        Insert: {
          node_id: string
          org_id: string
          template_id: string
          updated_at?: string
        }
        Update: {
          node_id?: string
          org_id?: string
          template_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "node_shift_templates_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "node_shift_templates_org_id_node_id_fkey"
            columns: ["org_id", "node_id"]
            isOneToOne: false
            referencedRelation: "nodes"
            referencedColumns: ["org_id", "id"]
          },
          {
            foreignKeyName: "node_shift_templates_org_id_template_id_fkey"
            columns: ["org_id", "template_id"]
            isOneToOne: false
            referencedRelation: "shift_templates"
            referencedColumns: ["org_id", "id"]
          },
        ]
      }
      node_skill_requirements: {
        Row: {
          created_at: string
          node_id: string
          org_id: string
          skill_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          node_id: string
          org_id: string
          skill_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          node_id?: string
          org_id?: string
          skill_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "node_skill_requirements_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "node_skill_requirements_org_id_node_id_fkey"
            columns: ["org_id", "node_id"]
            isOneToOne: false
            referencedRelation: "nodes"
            referencedColumns: ["org_id", "id"]
          },
          {
            foreignKeyName: "node_skill_requirements_org_id_skill_id_fkey"
            columns: ["org_id", "skill_id"]
            isOneToOne: false
            referencedRelation: "skills"
            referencedColumns: ["org_id", "id"]
          },
        ]
      }
      nodes: {
        Row: {
          active: boolean
          created_at: string
          id: string
          level_id: string
          name: string
          org_id: string
          parent_id: string | null
          path: unknown
          sort_order: number
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          id?: string
          level_id: string
          name: string
          org_id: string
          parent_id?: string | null
          path: unknown
          sort_order?: number
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          id?: string
          level_id?: string
          name?: string
          org_id?: string
          parent_id?: string | null
          path?: unknown
          sort_order?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "nodes_level_id_fkey"
            columns: ["level_id"]
            isOneToOne: false
            referencedRelation: "hierarchy_levels"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "nodes_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "nodes_org_id_parent_id_fkey"
            columns: ["org_id", "parent_id"]
            isOneToOne: false
            referencedRelation: "nodes"
            referencedColumns: ["org_id", "id"]
          },
          {
            foreignKeyName: "nodes_org_level_fkey"
            columns: ["org_id", "level_id"]
            isOneToOne: false
            referencedRelation: "hierarchy_levels"
            referencedColumns: ["org_id", "id"]
          },
        ]
      }
      operator_skills: {
        Row: {
          certified_at: string | null
          created_at: string
          expires_at: string | null
          operator_id: string
          org_id: string
          skill_id: string
          updated_at: string
        }
        Insert: {
          certified_at?: string | null
          created_at?: string
          expires_at?: string | null
          operator_id: string
          org_id: string
          skill_id: string
          updated_at?: string
        }
        Update: {
          certified_at?: string | null
          created_at?: string
          expires_at?: string | null
          operator_id?: string
          org_id?: string
          skill_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "operator_skills_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "operator_skills_org_id_operator_id_fkey"
            columns: ["org_id", "operator_id"]
            isOneToOne: false
            referencedRelation: "operators"
            referencedColumns: ["org_id", "id"]
          },
          {
            foreignKeyName: "operator_skills_org_id_skill_id_fkey"
            columns: ["org_id", "skill_id"]
            isOneToOne: false
            referencedRelation: "skills"
            referencedColumns: ["org_id", "id"]
          },
        ]
      }
      operators: {
        Row: {
          active: boolean
          created_at: string
          display_name: string
          employee_ref: string | null
          external_id: string | null
          home_node_id: string | null
          id: string
          org_id: string
          site_node_id: string
          source: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          display_name: string
          employee_ref?: string | null
          external_id?: string | null
          home_node_id?: string | null
          id?: string
          org_id: string
          site_node_id: string
          source?: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          display_name?: string
          employee_ref?: string | null
          external_id?: string | null
          home_node_id?: string | null
          id?: string
          org_id?: string
          site_node_id?: string
          source?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "operators_home_node_id_fkey"
            columns: ["home_node_id"]
            isOneToOne: false
            referencedRelation: "nodes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "operators_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "operators_org_id_home_node_id_fkey"
            columns: ["org_id", "home_node_id"]
            isOneToOne: false
            referencedRelation: "nodes"
            referencedColumns: ["org_id", "id"]
          },
          {
            foreignKeyName: "operators_org_id_site_node_id_fkey"
            columns: ["org_id", "site_node_id"]
            isOneToOne: false
            referencedRelation: "nodes"
            referencedColumns: ["org_id", "id"]
          },
        ]
      }
      orgs: {
        Row: {
          id: string
          name: string
          settings: Json
        }
        Insert: {
          id?: string
          name: string
          settings?: Json
        }
        Update: {
          id?: string
          name?: string
          settings?: Json
        }
        Relationships: []
      }
      products: {
        Row: {
          active: boolean
          color_token: string
          created_at: string
          external_id: string | null
          id: string
          name: string
          org_id: string
          site_node_id: string
          sku: string
          source: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          color_token: string
          created_at?: string
          external_id?: string | null
          id?: string
          name: string
          org_id: string
          site_node_id: string
          sku: string
          source?: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          color_token?: string
          created_at?: string
          external_id?: string | null
          id?: string
          name?: string
          org_id?: string
          site_node_id?: string
          sku?: string
          source?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "products_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "products_org_id_site_node_id_fkey"
            columns: ["org_id", "site_node_id"]
            isOneToOne: false
            referencedRelation: "nodes"
            referencedColumns: ["org_id", "id"]
          },
        ]
      }
      profile_grants: {
        Row: {
          created_at: string
          node_id: string
          org_id: string
          profile_id: string
          role: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          node_id: string
          org_id: string
          profile_id: string
          role?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          node_id?: string
          org_id?: string
          profile_id?: string
          role?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "profile_grants_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "profile_grants_org_id_node_id_fkey"
            columns: ["org_id", "node_id"]
            isOneToOne: false
            referencedRelation: "nodes"
            referencedColumns: ["org_id", "id"]
          },
          {
            foreignKeyName: "profile_grants_org_id_profile_id_fkey"
            columns: ["org_id", "profile_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["org_id", "id"]
          },
        ]
      }
      runs: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          node_id: string
          notes: string | null
          org_id: string
          planned_headcount: number | null
          product_color_token: string | null
          product_id: string | null
          product_name: string | null
          product_sku: string | null
          status: string
          timerange: unknown
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          node_id: string
          notes?: string | null
          org_id: string
          planned_headcount?: number | null
          product_color_token?: string | null
          product_id?: string | null
          product_name?: string | null
          product_sku?: string | null
          status?: string
          timerange: unknown
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          node_id?: string
          notes?: string | null
          org_id?: string
          planned_headcount?: number | null
          product_color_token?: string | null
          product_id?: string | null
          product_name?: string | null
          product_sku?: string | null
          status?: string
          timerange?: unknown
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "runs_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "runs_org_id_node_id_fkey"
            columns: ["org_id", "node_id"]
            isOneToOne: false
            referencedRelation: "nodes"
            referencedColumns: ["org_id", "id"]
          },
          {
            foreignKeyName: "runs_org_id_product_id_fkey"
            columns: ["org_id", "product_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["org_id", "id"]
          },
        ]
      }
      shift_breaks: {
        Row: {
          end_min: number
          id: string
          name: string
          org_id: string
          shift_id: string
          start_min: number
          updated_at: string
        }
        Insert: {
          end_min: number
          id?: string
          name?: string
          org_id: string
          shift_id: string
          start_min: number
          updated_at?: string
        }
        Update: {
          end_min?: number
          id?: string
          name?: string
          org_id?: string
          shift_id?: string
          start_min?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "shift_breaks_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shift_breaks_org_id_shift_id_fkey"
            columns: ["org_id", "shift_id"]
            isOneToOne: false
            referencedRelation: "shifts"
            referencedColumns: ["org_id", "id"]
          },
        ]
      }
      shift_templates: {
        Row: {
          active: boolean
          id: string
          name: string
          org_id: string
          site_node_id: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          id?: string
          name: string
          org_id: string
          site_node_id: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          id?: string
          name?: string
          org_id?: string
          site_node_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "shift_templates_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shift_templates_org_id_site_node_id_fkey"
            columns: ["org_id", "site_node_id"]
            isOneToOne: false
            referencedRelation: "nodes"
            referencedColumns: ["org_id", "id"]
          },
        ]
      }
      shifts: {
        Row: {
          end_min: number
          id: string
          name: string
          org_id: string
          start_min: number
          template_id: string
          updated_at: string
        }
        Insert: {
          end_min: number
          id?: string
          name: string
          org_id: string
          start_min: number
          template_id: string
          updated_at?: string
        }
        Update: {
          end_min?: number
          id?: string
          name?: string
          org_id?: string
          start_min?: number
          template_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "shifts_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shifts_org_id_template_id_fkey"
            columns: ["org_id", "template_id"]
            isOneToOne: false
            referencedRelation: "shift_templates"
            referencedColumns: ["org_id", "id"]
          },
        ]
      }
      skills: {
        Row: {
          active: boolean
          created_at: string
          id: string
          name: string
          org_id: string
          site_node_id: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          id?: string
          name: string
          org_id: string
          site_node_id: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          id?: string
          name?: string
          org_id?: string
          site_node_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "skills_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "skills_org_id_site_node_id_fkey"
            columns: ["org_id", "site_node_id"]
            isOneToOne: false
            referencedRelation: "nodes"
            referencedColumns: ["org_id", "id"]
          },
        ]
      }
      user_profiles: {
        Row: {
          created_at: string
          default_create_mode: string
          id: string
          org_id: string
          role: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          default_create_mode?: string
          id?: string
          org_id: string
          role?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          default_create_mode?: string
          id?: string
          org_id?: string
          role?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_profiles_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "orgs"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      api_raise: {
        Args: { p_detail: Json; p_error: string; p_message: string }
        Returns: undefined
      }
      app_can_edit_node: { Args: { p_node: string }; Returns: boolean }
      app_can_read_node: { Args: { p_node: string }; Returns: boolean }
      app_can_read_operator: { Args: { p_operator: string }; Returns: boolean }
      app_can_read_owned: { Args: { p_site_node: string }; Returns: boolean }
      app_can_read_shift: { Args: { p_shift: string }; Returns: boolean }
      app_can_read_shift_template: {
        Args: { p_template: string }
        Returns: boolean
      }
      app_can_write: { Args: never; Returns: boolean }
      app_current_org: { Args: never; Returns: string }
      app_current_profile_id: { Args: never; Returns: string }
      app_grant_paths: { Args: { require_edit: boolean }; Returns: unknown[] }
      app_grant_paths_for: { Args: { p_roles: string[] }; Returns: unknown[] }
      app_is_admin: { Args: never; Returns: boolean }
      app_is_admin_anywhere: { Args: never; Returns: boolean }
      app_is_admin_for: { Args: { p_node: string }; Returns: boolean }
      app_is_admin_for_operator: {
        Args: { p_operator_id: string }
        Returns: boolean
      }
      app_is_admin_for_shift: { Args: { p_shift_id: string }; Returns: boolean }
      app_is_admin_for_shift_template: {
        Args: { p_template_id: string }
        Returns: boolean
      }
      app_is_admin_for_template: {
        Args: { p_template_id: string }
        Returns: boolean
      }
      app_is_admin_on_grant_node: {
        Args: { p_node_id: string }
        Returns: boolean
      }
      app_is_admin_on_path: { Args: { p_path: unknown }; Returns: boolean }
      app_node_exists_in_org: { Args: { p_node_id: string }; Returns: boolean }
      app_owner_covers: {
        Args: { p_node: string; p_owner: string }
        Returns: boolean
      }
      app_owner_covers_in_org: {
        Args: { p_node: string; p_org: string; p_owner: string }
        Returns: boolean
      }
      app_pick_product_color: {
        Args: { p_org_id: string; p_site_node_id: string }
        Returns: string
      }
      app_product_palette: { Args: never; Returns: string[] }
      app_profile_exists_in_org: {
        Args: { p_profile_id: string }
        Returns: boolean
      }
      app_profile_is_company_admin: {
        Args: { p_profile_id: string }
        Returns: boolean
      }
      app_relevel_subtree: {
        Args: { p_delta: number; p_new_parent_id: string; p_node_id: string }
        Returns: Json
      }
      app_trim_ws: { Args: { input: string }; Returns: string }
      apply_split_coverage: {
        Args: { p_adjustments: Json; p_new_assignment: Json }
        Returns: Json
      }
      audit_current_actor: { Args: never; Returns: string }
      board_window: {
        Args: { p_from: string; p_root_path: unknown; p_to: string }
        Returns: Json
      }
      capacity_probe: {
        Args: {
          p_efficiency: number
          p_exclude_assignment_id?: string
          p_operator_id: string
          p_timerange: unknown
        }
        Returns: Json
      }
      check_eligibility: {
        Args: { p_node_id: string; p_operator_id: string; p_timerange: unknown }
        Returns: Json
      }
      create_assignment: {
        Args: {
          p_area_override?: boolean
          p_area_override_reason?: string
          p_efficiency?: number
          p_eligibility_override?: boolean
          p_node_id: string
          p_operator_id: string
          p_override_reason?: string
          p_product_id: string
          p_run_id: string
          p_target_qty?: number
          p_target_unit?: string
          p_timerange: unknown
        }
        Returns: Json
      }
      create_hierarchy_template: { Args: { p_name: string }; Returns: Json }
      create_node: {
        Args: {
          p_name: string
          p_parent_id: string
          p_sort_order?: number
          p_template_id?: string
        }
        Returns: Json
      }
      create_run: {
        Args: {
          p_node_id: string
          p_notes?: string
          p_planned_headcount?: number
          p_product_id: string
          p_timerange: unknown
        }
        Returns: Json
      }
      delete_hierarchy_template: {
        Args: { p_template_id: string }
        Returns: Json
      }
      delete_node: {
        Args: { p_mode?: string; p_node_id: string }
        Returns: Json
      }
      delete_owned_row: {
        Args: { p_id: string; p_kind: string }
        Returns: Json
      }
      delete_run: { Args: { p_mode?: string; p_run_id: string }; Returns: Json }
      deletion_preview: {
        Args: { p_id: string; p_kind: string }
        Returns: Json
      }
      demote_node: {
        Args: { p_new_parent_id: string; p_node_id: string }
        Returns: Json
      }
      editable_shape_ids: { Args: never; Returns: Json }
      move_node: {
        Args: {
          p_new_parent_id: string
          p_node_id: string
          p_sort_order?: number
        }
        Returns: Json
      }
      move_run: {
        Args: {
          p_area_override?: boolean
          p_area_override_reason?: string
          p_node_id: string
          p_run_id: string
          p_timerange: unknown
        }
        Returns: Json
      }
      operator_peak_load: {
        Args: {
          p_efficiency: number
          p_exclude_assignment_id?: string
          p_operator_id: string
          p_timerange: unknown
        }
        Returns: number
      }
      place_node: {
        Args: { p_index: number; p_new_parent_id: string; p_node_id: string }
        Returns: Json
      }
      promote_node: { Args: { p_node_id: string }; Returns: Json }
      remove_site_member: {
        Args: { p_node_id: string; p_profile_id: string }
        Returns: Json
      }
      rename_hierarchy_template: {
        Args: { p_name: string; p_template_id: string }
        Returns: Json
      }
      rename_node: {
        Args: { p_name: string; p_node_id: string }
        Returns: Json
      }
      resolve_shift_template: { Args: { p_node_id: string }; Returns: string }
      save_hierarchy_levels: {
        Args: { p_levels: Json; p_template_id: string }
        Returns: Json
      }
      set_site_member: {
        Args: { p_node_id: string; p_profile_id: string; p_role: string }
        Returns: Json
      }
      site_people: { Args: { p_node_id: string }; Returns: Json }
      slugify: { Args: { input: string }; Returns: string }
      text2ltree: { Args: { "": string }; Returns: unknown }
      visible_board_roots: {
        Args: never
        Returns: {
          id: string
          name: string
          path: string
        }[]
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const

