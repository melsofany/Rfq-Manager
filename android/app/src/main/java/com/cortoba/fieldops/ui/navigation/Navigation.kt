package com.cortoba.fieldops.ui.navigation

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.cortoba.fieldops.ui.auth.LoginScreen
import com.cortoba.fieldops.ui.custody.CustodyScreen
import com.cortoba.fieldops.ui.dashboard.DashboardScreen
import com.cortoba.fieldops.ui.deliveries.DeliveryConfirmScreen
import com.cortoba.fieldops.ui.deliveries.DeliveryDetailScreen
import com.cortoba.fieldops.ui.deliveries.DeliveryListScreen
import com.cortoba.fieldops.ui.notifications.NotificationsScreen
import com.cortoba.fieldops.ui.pickups.PickupDetailScreen
import com.cortoba.fieldops.ui.pickups.PickupListScreen
import com.cortoba.fieldops.ui.pickups.ReceiptConfirmScreen
import com.cortoba.fieldops.ui.profile.ProfileScreen
import com.cortoba.fieldops.ui.profile.SettingsScreen

object Routes {
    const val LOGIN = "login"
    const val DASHBOARD = "dashboard"
    const val PICKUPS = "pickups"
    const val PICKUP_DETAIL = "pickups/{assignmentId}"
    const val RECEIPT_CONFIRM = "pickups/{assignmentId}/confirm"
    const val DELIVERIES = "deliveries"
    const val DELIVERY_DETAIL = "deliveries/{assignmentId}"
    const val DELIVERY_CONFIRM = "deliveries/{assignmentId}/confirm"
    const val NOTIFICATIONS = "notifications"
    const val PROFILE = "profile"
    const val SETTINGS = "settings"
    const val CUSTODY = "custody"

    fun pickupDetail(assignmentId: Int) = "pickups/$assignmentId"
    fun receiptConfirm(assignmentId: Int) = "pickups/$assignmentId/confirm"
    fun deliveryDetail(assignmentId: Int) = "deliveries/$assignmentId"
    fun deliveryConfirm(assignmentId: Int) = "deliveries/$assignmentId/confirm"
}

/**
 * The whole navigation graph.
 *
 * The start destination follows the session, so a representative with a valid
 * stored token lands on the dashboard and a signed-out one lands on login — and
 * a forced logout (server revoked the session) pops everything back to login.
 */
@Composable
fun CortobaNavHost(
    navController: NavHostController = rememberNavController(),
    rootViewModel: RootViewModel = hiltViewModel(),
) {
    // Read ONCE. Recomputing this on every recomposition would rebuild the graph
    // the moment login flips the session flag, racing the explicit navigation
    // that the login screen already performs.
    val startDestination = remember { if (rootViewModel.signedIn.value) Routes.DASHBOARD else Routes.LOGIN }

    NavHost(navController = navController, startDestination = startDestination) {
        composable(Routes.LOGIN) {
            LoginScreen(
                onSignedIn = {
                    navController.navigate(Routes.DASHBOARD) {
                        popUpTo(Routes.LOGIN) { inclusive = true }
                    }
                },
            )
        }

        composable(Routes.DASHBOARD) {
            DashboardScreen(
                onOpenPickups = { navController.navigate(Routes.PICKUPS) },
                onOpenDeliveries = { navController.navigate(Routes.DELIVERIES) },
                onOpenCustody = { navController.navigate(Routes.CUSTODY) },
                onOpenNotifications = { navController.navigate(Routes.NOTIFICATIONS) },
                onOpenProfile = { navController.navigate(Routes.PROFILE) },
                onSignedOut = {
                    navController.navigate(Routes.LOGIN) {
                        popUpTo(0) { inclusive = true }
                    }
                },
            )
        }

        composable(Routes.PICKUPS) {
            PickupListScreen(
                onBack = { navController.popBackStack() },
                onOpen = { navController.navigate(Routes.pickupDetail(it)) },
            )
        }

        composable(
            route = Routes.PICKUP_DETAIL,
            arguments = listOf(navArgument("assignmentId") { type = NavType.IntType }),
        ) { entry ->
            val assignmentId = entry.arguments?.getInt("assignmentId") ?: 0
            PickupDetailScreen(
                assignmentId = assignmentId,
                onBack = { navController.popBackStack() },
                onConfirm = { navController.navigate(Routes.receiptConfirm(it)) },
            )
        }

        composable(
            route = Routes.RECEIPT_CONFIRM,
            arguments = listOf(navArgument("assignmentId") { type = NavType.IntType }),
        ) { entry ->
            val assignmentId = entry.arguments?.getInt("assignmentId") ?: 0
            ReceiptConfirmScreen(
                assignmentId = assignmentId,
                onBack = { navController.popBackStack() },
                onDone = {
                    // Return to the list so the representative sees the updated
                    // status rather than a stale detail screen.
                    navController.popBackStack(Routes.PICKUPS, inclusive = false)
                },
            )
        }

        composable(Routes.DELIVERIES) {
            DeliveryListScreen(
                onBack = { navController.popBackStack() },
                onOpen = { navController.navigate(Routes.deliveryDetail(it)) },
            )
        }

        composable(
            route = Routes.DELIVERY_DETAIL,
            arguments = listOf(navArgument("assignmentId") { type = NavType.IntType }),
        ) { entry ->
            val assignmentId = entry.arguments?.getInt("assignmentId") ?: 0
            DeliveryDetailScreen(
                assignmentId = assignmentId,
                onBack = { navController.popBackStack() },
                onConfirm = { navController.navigate(Routes.deliveryConfirm(it)) },
            )
        }

        composable(
            route = Routes.DELIVERY_CONFIRM,
            arguments = listOf(navArgument("assignmentId") { type = NavType.IntType }),
        ) { entry ->
            val assignmentId = entry.arguments?.getInt("assignmentId") ?: 0
            DeliveryConfirmScreen(
                assignmentId = assignmentId,
                onBack = { navController.popBackStack() },
                onDone = { navController.popBackStack(Routes.DELIVERIES, inclusive = false) },
            )
        }

        composable(Routes.NOTIFICATIONS) {
            NotificationsScreen(onBack = { navController.popBackStack() })
        }

        composable(Routes.PROFILE) {
            ProfileScreen(
                onBack = { navController.popBackStack() },
                onOpenSettings = { navController.navigate(Routes.SETTINGS) },
                onSignedOut = {
                    navController.navigate(Routes.LOGIN) { popUpTo(0) { inclusive = true } }
                },
            )
        }

        composable(Routes.SETTINGS) {
            SettingsScreen(
                onBack = { navController.popBackStack() },
                onSignedOut = {
                    navController.navigate(Routes.LOGIN) { popUpTo(0) { inclusive = true } }
                },
            )
        }

        composable(Routes.CUSTODY) {
            CustodyScreen(onBack = { navController.popBackStack() })
        }
    }
}
