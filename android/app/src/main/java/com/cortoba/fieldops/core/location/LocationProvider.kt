package com.cortoba.fieldops.core.location

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import com.cortoba.fieldops.core.network.dto.GpsPoint

/**
 * Best-effort location for evidence.
 *
 * Deliberately conservative: if the permission is missing or the platform has no
 * last-known fix, this returns null and the operation proceeds WITHOUT
 * coordinates. Blocking a receipt because GPS is unavailable would stop real
 * work, and the requirement is "GPS if permitted", not "GPS required".
 */
object LocationProvider {

    private var appContext: Context? = null

    fun init(context: Context) {
        appContext = context.applicationContext
    }

    @SuppressLint("MissingPermission")
    fun lastKnown(): GpsPoint? {
        val context = appContext ?: return null
        val fine = ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION)
        val coarse = ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION)
        if (fine != PackageManager.PERMISSION_GRANTED && coarse != PackageManager.PERMISSION_GRANTED) {
            return null
        }
        val manager =
            context.getSystemService(Context.LOCATION_SERVICE) as? android.location.LocationManager
                ?: return null
        val location = runCatching {
            manager.getLastKnownLocation(android.location.LocationManager.GPS_PROVIDER)
                ?: manager.getLastKnownLocation(android.location.LocationManager.NETWORK_PROVIDER)
        }.getOrNull() ?: return null
        return GpsPoint(lat = location.latitude, lng = location.longitude)
    }
}
