package io.github.ekqlem1006.planner

import android.app.Activity
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.os.Bundle
import android.os.CancellationSignal
import android.view.View
import android.widget.Button
import android.widget.TextView
import android.widget.Toast
import androidx.core.content.ContextCompat
import androidx.credentials.ClearCredentialStateRequest
import androidx.credentials.CredentialManager
import androidx.credentials.CredentialManagerCallback
import androidx.credentials.CustomCredential
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetCredentialResponse
import androidx.credentials.exceptions.ClearCredentialException
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import com.google.firebase.FirebaseApp
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.GoogleAuthProvider

/** 로그인과 위젯 설치만 맡는 화면. 할 일 관리는 위젯과 웹 플래너에서 한다. */
class MainActivity : Activity() {
    private lateinit var status: TextView
    private lateinit var login: Button
    private lateinit var pin: Button
    private lateinit var refresh: Button
    private lateinit var logout: Button

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        status = findViewById(R.id.status)
        login = findViewById(R.id.login)
        pin = findViewById(R.id.pin)
        refresh = findViewById(R.id.refresh_now)
        logout = findViewById(R.id.logout)

        login.setOnClickListener { signIn() }
        pin.setOnClickListener { pinWidget() }
        refresh.setOnClickListener {
            PlannerWidget.refreshAll(this)
            Toast.makeText(this, R.string.refreshed, Toast.LENGTH_SHORT).show()
        }
        logout.setOnClickListener { signOut() }
        render()
    }

    override fun onResume() {
        super.onResume()
        render()
    }

    private fun configured(): Boolean = FirebaseApp.getApps(this).isNotEmpty()

    private fun render(message: String? = null) {
        if (!configured()) {
            status.text = getString(R.string.not_configured)
            listOf(login, pin, refresh, logout).forEach { it.visibility = View.GONE }
            return
        }
        val user = FirebaseAuth.getInstance().currentUser
        status.text = message
            ?: if (user == null) getString(R.string.signed_out)
            else getString(R.string.signed_in, user.email ?: user.displayName ?: "")
        login.visibility = if (user == null) View.VISIBLE else View.GONE
        listOf(pin, refresh, logout).forEach { it.visibility = if (user == null) View.GONE else View.VISIBLE }
    }

    private fun signIn() {
        // google-services.json 이 만들어 주는 리소스라 파일이 없을 때도 컴파일되도록 이름으로 찾는다
        val resId = resources.getIdentifier("default_web_client_id", "string", packageName)
        if (resId == 0) {
            render(getString(R.string.no_web_client))
            return
        }
        val request = GetCredentialRequest.Builder()
            .addCredentialOption(GetSignInWithGoogleOption.Builder(getString(resId)).build())
            .build()

        login.isEnabled = false
        CredentialManager.create(this).getCredentialAsync(
            this, request, CancellationSignal(), ContextCompat.getMainExecutor(this),
            object : CredentialManagerCallback<GetCredentialResponse, GetCredentialException> {
                override fun onResult(result: GetCredentialResponse) {
                    val cred = result.credential
                    if (cred is CustomCredential &&
                        cred.type == GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL
                    ) {
                        val idToken = GoogleIdTokenCredential.createFrom(cred.data).idToken
                        FirebaseAuth.getInstance()
                            .signInWithCredential(GoogleAuthProvider.getCredential(idToken, null))
                            .addOnCompleteListener { task ->
                                login.isEnabled = true
                                if (task.isSuccessful) {
                                    render()
                                    PlannerWidget.refreshAll(this@MainActivity)
                                } else {
                                    render(getString(R.string.login_failed, task.exception?.message ?: ""))
                                }
                            }
                    } else {
                        login.isEnabled = true
                        render(getString(R.string.login_failed, cred.type))
                    }
                }

                override fun onError(e: GetCredentialException) {
                    login.isEnabled = true
                    if (e is GetCredentialCancellationException) render()
                    else render(getString(R.string.login_failed, "${e.type}\n${e.message ?: ""}"))
                }
            }
        )
    }

    private fun signOut() {
        FirebaseAuth.getInstance().signOut()
        CredentialManager.create(this).clearCredentialStateAsync(
            ClearCredentialStateRequest(), CancellationSignal(), ContextCompat.getMainExecutor(this),
            object : CredentialManagerCallback<Void?, ClearCredentialException> {
                override fun onResult(result: Void?) {}
                override fun onError(e: ClearCredentialException) {}
            }
        )
        render()
        PlannerWidget.refreshAll(this)
    }

    private fun pinWidget() {
        val manager = getSystemService(AppWidgetManager::class.java)
        if (manager.isRequestPinAppWidgetSupported) {
            manager.requestPinAppWidget(ComponentName(this, PlannerWidget::class.java), null, null)
        } else {
            Toast.makeText(this, R.string.pin_unsupported, Toast.LENGTH_LONG).show()
        }
    }
}
