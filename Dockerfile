# Base image
FROM dockerhub.trinityiot.in/tsf/trinitybase/tomcatbaseimg/tomcatjdk18baseimg:10.1.50


# Copy the .war file from the target directory to the Tomcat webapps directory
COPY *.war /usr/local/tomcat/webapps/

# Specify the volume for Tomcat logs
VOLUME /usr/local/tomcat/logs

# Expose port 8080 for accessing the application
EXPOSE 8080 8443

# Start Tomcat and tail the /dev/null file to keep the container running
USER 1001
CMD ["sh", "-c", "sh /usr/local/tomcat/bin/catalina.sh run | tee -a /usr/local/tomcat/logs/catalina.out"]
